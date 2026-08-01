//! A streaming session: transport in, rolling buffer, bytes out.
//!
//! Watch Online never downloads the whole file. A session pulls the chunks
//! around the playhead into [`RingCache`], serves reads from there, and lets
//! everything else go. Pressing "Save Offline" mid-playback attaches a tap that
//! also writes arriving chunks into a `.partial` — the same `.partial` the
//! download engine understands, so the leftover gaps can be filled by a normal
//! resume once viewing ends.

use crate::cache::{Chunk, RingCache};
use prev_core::{
    ChunkMap, ChunkPlan, EngineError, EngineEvent, EventSink, Result, ShareLink, StreamStats,
    TransferState,
};
use prev_download::state::{now, DownloadRecord, StateStore};
use prev_download::writer::{partial_path, PartialWriter};
use prev_transport::{read_range_retrying, RetryPolicy, Transport};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone, Debug)]
pub struct StreamConfig {
    /// Hard ceiling on RAM held for this session.
    pub cache_limit: u64,
    /// How far ahead of the playhead to prefetch.
    pub ahead_bytes: u64,
    /// How much played-back data to retain for instant small rewinds.
    pub behind_bytes: u64,
    /// Chunks fetched concurrently while prefetching.
    pub prefetch_workers: usize,
    pub retry: RetryPolicy,
    pub stats_interval_ms: u64,
    /// Chunk size for streaming, chosen independently of the sender's grid.
    ///
    /// A share link sizes its chunks for download throughput — 16 MB for a
    /// 26 GB film. That is the wrong trade for playback: it makes the first
    /// frame wait for 16 MB, and a 64 MB buffer would hold only four chunks.
    /// The transport serves arbitrary ranges, so the receiver is free to use a
    /// finer grid, and does.
    pub chunk_size: u32,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            cache_limit: 256 * 1024 * 1024,
            ahead_bytes: 96 * 1024 * 1024,
            behind_bytes: 32 * 1024 * 1024,
            prefetch_workers: 4,
            retry: RetryPolicy::realtime(),
            stats_interval_ms: 500,
            chunk_size: 2 * 1024 * 1024,
        }
    }
}

impl StreamConfig {
    /// Clamp a user-chosen cache size into something that can actually stream.
    ///
    /// The window has to fit inside the cache or the prefetcher would evict the
    /// very chunks it just fetched and spin forever. The chunk size is pulled
    /// down too if it is coarse relative to the budget: a cache that holds only
    /// a handful of chunks has no room to absorb a seek.
    pub fn with_cache_limit(mut self, limit: u64) -> Self {
        self.cache_limit = limit.max(4 * 1024 * 1024);
        // Aim for at least 16 chunks in the cache so the window and the rewind
        // history can coexist without fighting.
        let target = (self.cache_limit / 16).max(prev_core::MIN_CHUNK_SIZE as u64);
        self.chunk_size = self.chunk_size.min(target as u32).max(prev_core::MIN_CHUNK_SIZE);
        self.ahead_bytes = self.ahead_bytes.min(self.cache_limit * 3 / 4);
        self.behind_bytes = self.behind_bytes.min(self.cache_limit / 4);
        self
    }
}

struct SaveTap {
    writer: PartialWriter,
    map: ChunkMap,
    record_id: String,
    store: Arc<StateStore>,
    bytes: u64,
}

pub struct StreamSession {
    id: String,
    name: String,
    plan: ChunkPlan,
    transport: Arc<dyn Transport>,
    link: ShareLink,
    config: StreamConfig,
    sink: EventSink,

    cache: Mutex<RingCache>,
    inflight: Mutex<HashSet<u32>>,
    arrived: Notify,

    playhead: AtomicU64,
    fetches: AtomicU64,
    stop: AtomicBool,
    save: Mutex<Option<SaveTap>>,
}

impl StreamSession {
    /// Open a session for a resolved link. Nothing is fetched until the first
    /// read or the prefetcher starts.
    pub fn new(
        id: impl Into<String>,
        link: &ShareLink,
        transport: Arc<dyn Transport>,
        config: StreamConfig,
        sink: EventSink,
    ) -> Result<Arc<Self>> {
        // The receiver's own grid, not the sender's: see StreamConfig::chunk_size.
        let plan = ChunkPlan::new(link.size, config.chunk_size);
        if plan.total == 0 {
            return Err(EngineError::Transport(
                "cannot stream a source of unknown size".into(),
            ));
        }
        let behind_chunks = (config.behind_bytes / plan.chunk_size.max(1) as u64) as u32;
        Ok(Arc::new(Self {
            id: id.into(),
            name: link.name.clone(),
            plan,
            transport,
            link: link.clone(),
            cache: Mutex::new(RingCache::new(config.cache_limit, behind_chunks.max(1))),
            inflight: Mutex::new(HashSet::new()),
            arrived: Notify::new(),
            playhead: AtomicU64::new(0),
            fetches: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            save: Mutex::new(None),
            config,
            sink,
        }))
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn plan(&self) -> &ChunkPlan {
        &self.plan
    }

    pub fn total(&self) -> u64 {
        self.plan.total
    }

    pub fn content_type(&self) -> String {
        prev_core::content_type(&self.name).to_string()
    }

    pub fn playhead(&self) -> u64 {
        self.playhead.load(Ordering::Relaxed)
    }

    pub fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// Start the background prefetcher and stats reporter.
    pub fn spawn_background(self: &Arc<Self>) {
        let s = self.clone();
        tokio::spawn(async move { prefetch_loop(s).await });
        let s = self.clone();
        tokio::spawn(async move { stats_loop(s).await });
    }

    /// Read into `buf`, returning how many bytes were filled. Blocks (async)
    /// until the covering chunks are resident.
    pub async fn read_into(&self, offset: u64, buf: &mut [u8]) -> Result<usize> {
        if offset >= self.plan.total || buf.is_empty() {
            return Ok(0);
        }
        let end = (offset + buf.len() as u64).min(self.plan.total);
        let want = (end - offset) as usize;
        self.playhead.store(offset, Ordering::Relaxed);

        let mut written = 0usize;
        for idx in self.plan.indices_for(offset, want as u64) {
            if self.stop.load(Ordering::Relaxed) {
                return Err(EngineError::Cancelled);
            }
            let chunk = self.chunk(idx).await?;
            let (chunk_off, chunk_len) = self.plan.range(idx);
            let skip = offset.saturating_sub(chunk_off) as usize;
            let take = (chunk_len as usize - skip).min(want - written);
            buf[written..written + take].copy_from_slice(&chunk[skip..skip + take]);
            written += take;
            if written == want {
                break;
            }
        }
        Ok(written)
    }

    /// Convenience wrapper that allocates. Prefer [`read_into`](Self::read_into)
    /// on the hot path.
    pub async fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>> {
        let cap = len.min(self.plan.total.saturating_sub(offset) as usize);
        let mut buf = vec![0u8; cap];
        let n = self.read_into(offset, &mut buf).await?;
        buf.truncate(n);
        Ok(buf)
    }

    /// Cached chunk, or fetch it. Concurrent readers wanting the same chunk
    /// share one fetch rather than racing to download it twice.
    async fn chunk(&self, index: u32) -> Result<Chunk> {
        loop {
            if let Some(c) = self.cache.lock().unwrap().get(index) {
                return Ok(c);
            }
            let mine = self.inflight.lock().unwrap().insert(index);
            if mine {
                break;
            }
            // Someone else owns this fetch. Re-check on a short timer so a
            // notification lost to a race costs milliseconds, not a stall.
            let _ = tokio::time::timeout(Duration::from_millis(50), self.arrived.notified()).await;
            if self.stop.load(Ordering::Relaxed) {
                return Err(EngineError::Cancelled);
            }
        }

        let result = self.fetch(index).await;
        self.inflight.lock().unwrap().remove(&index);
        self.arrived.notify_waiters();
        result
    }

    async fn fetch(&self, index: u32) -> Result<Chunk> {
        let (offset, len) = self.plan.range(index);
        let mut buf = Vec::with_capacity(len as usize);
        read_range_retrying(self.transport.as_ref(), offset, len, &mut buf, self.config.retry)
            .await?;
        self.fetches.fetch_add(1, Ordering::Relaxed);

        let chunk: Chunk = Arc::new(buf);
        self.tap_save(index, &chunk);

        let playhead_index = self.plan.index_of(self.playhead());
        self.cache.lock().unwrap().insert(index, chunk.clone(), playhead_index);
        Ok(chunk)
    }

    // -- Save Offline -------------------------------------------------------

    /// Begin writing arriving chunks to disk without interrupting playback.
    ///
    /// Everything already in the buffer is flushed immediately, so pressing
    /// this ten minutes in keeps the last few minutes rather than only what
    /// arrives next. Returns the download id the transfer can be resumed under.
    pub fn start_saving(&self, dest_dir: impl AsRef<Path>, store: Arc<StateStore>) -> Result<String> {
        if self.save.lock().unwrap().is_some() {
            return Err(EngineError::Other("this stream is already being saved".into()));
        }
        let dest = dest_dir.as_ref().join(prev_download::sanitise(&self.name));
        let writer = PartialWriter::open(&dest, self.plan.total)?;
        let record_id = format!("save-{}", self.id);

        let rec = DownloadRecord {
            id: record_id.clone(),
            name: self.name.clone(),
            url: self.link.url.clone(),
            transport: self.link.transport.clone(),
            dest: dest.to_string_lossy().to_string(),
            partial: partial_path(&dest).to_string_lossy().to_string(),
            total: self.plan.total,
            chunk_size: self.plan.chunk_size,
            chunks_total: self.plan.count(),
            chunks_done: 0,
            // Paused, not running: the stream feeds it opportunistically, and
            // the download engine can adopt it to fill the gaps at any point.
            state: TransferState::Paused,
            sha256: self.link.sha256.clone(),
            hash_url: self.link.hash_url.clone(),
            error: None,
            created_at: now(),
            updated_at: now(),
        };
        let mut map = ChunkMap::new(self.plan.count());

        // Flush what is already buffered.
        let resident: Vec<(u32, Chunk)> = {
            let cache = self.cache.lock().unwrap();
            cache
                .resident_indices()
                .into_iter()
                .filter_map(|i| cache.get(i).map(|c| (i, c)))
                .collect()
        };
        let mut bytes = 0u64;
        for (idx, data) in resident {
            writer.write_chunk(self.plan.offset(idx), &data)?;
            map.set(idx);
            bytes += data.len() as u64;
        }

        store.insert(&rec, &map)?;
        *self.save.lock().unwrap() = Some(SaveTap { writer, map, record_id: record_id.clone(), store, bytes });
        Ok(record_id)
    }

    fn tap_save(&self, index: u32, data: &Chunk) {
        let mut guard = self.save.lock().unwrap();
        let Some(tap) = guard.as_mut() else {
            return;
        };
        if tap.map.has(index) {
            return;
        }
        if tap.writer.write_chunk(self.plan.offset(index), data).is_ok() {
            tap.map.set(index);
            tap.bytes += data.len() as u64;
            let _ = tap.store.save_progress(&tap.record_id, &tap.map);
        }
    }

    pub fn saved_bytes(&self) -> u64 {
        self.save.lock().unwrap().as_ref().map(|t| t.bytes).unwrap_or(0)
    }

    pub fn is_saving(&self) -> bool {
        self.save.lock().unwrap().is_some()
    }

    /// Stop saving.
    ///
    /// If every chunk happened to pass through the buffer the file is finished
    /// and renamed on the spot. Otherwise the `.partial` and its chunk map are
    /// left in the store, ready for `DownloadEngine::resume` to fetch only the
    /// gaps — the stream has already paid for most of the transfer.
    pub fn stop_saving(&self) -> Result<SaveOutcome> {
        let Some(tap) = self.save.lock().unwrap().take() else {
            return Ok(SaveOutcome::NotSaving);
        };
        tap.store.save_progress(&tap.record_id, &tap.map)?;
        if tap.map.is_complete() {
            let path = tap.writer.finish()?;
            tap.store.set_state(&tap.record_id, TransferState::Completed, None)?;
            Ok(SaveOutcome::Completed { id: tap.record_id, path })
        } else {
            tap.writer.flush()?;
            tap.store.set_state(&tap.record_id, TransferState::Paused, None)?;
            Ok(SaveOutcome::Resumable {
                id: tap.record_id,
                chunks_done: tap.map.done(),
                chunks_total: tap.map.count(),
            })
        }
    }

    // -- Lifecycle ----------------------------------------------------------

    pub fn stats(&self) -> StreamStats {
        let playhead = self.playhead();
        let cache = self.cache.lock().unwrap();
        StreamStats {
            id: self.id.clone(),
            playhead,
            buffered_ahead: cache.buffered_ahead(&self.plan, playhead),
            buffered_behind: cache.buffered_behind(&self.plan, playhead),
            cached_bytes: cache.bytes(),
            cache_limit: cache.limit(),
            chunks_resident: cache.len(),
            fetches: self.fetches.load(Ordering::Relaxed),
            saved_bytes: self.saved_bytes(),
            saving: self.save.lock().unwrap().is_some(),
        }
    }

    /// Stop playback: free every buffer immediately and wake anyone waiting.
    ///
    /// Disk usage after this is zero unless the user asked to save.
    pub fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.cache.lock().unwrap().clear();
        self.arrived.notify_waiters();
        (self.sink)(EngineEvent::StreamState {
            id: self.id.clone(),
            state: TransferState::Completed,
            error: None,
        });
    }
}

impl Drop for StreamSession {
    fn drop(&mut self) {
        // Belt and braces: whatever happens, the buffer does not outlive the
        // session.
        if let Ok(mut c) = self.cache.lock() {
            c.clear();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SaveOutcome {
    /// Everything streamed through the buffer, so the file is already complete.
    Completed { id: String, path: PathBuf },
    /// Gaps remain; resume this id to fill only those.
    Resumable { id: String, chunks_done: u32, chunks_total: u32 },
    NotSaving,
}

async fn prefetch_loop(session: Arc<StreamSession>) {
    loop {
        if session.stop.load(Ordering::Relaxed) {
            return;
        }
        let playhead = session.playhead();
        let plan = session.plan;
        let first = plan.index_of(playhead);

        let missing: Vec<u32> = {
            let cache = session.cache.lock().unwrap();
            let inflight = session.inflight.lock().unwrap();

            // Never reach past what the cache can actually keep. Asking for
            // more than fits means every arrival evicts a chunk still inside
            // the window, which is then re-fetched — the stream would pull the
            // file many times over while the player starves.
            let capacity = cache.capacity_chunks(plan.chunk_size);
            let reserved_behind = (capacity / 4).min(
                (session.config.behind_bytes / plan.chunk_size.max(1) as u64) as u32,
            );
            let window = capacity.saturating_sub(reserved_behind).max(1);

            let ahead_limit = plan.index_of(
                (playhead + session.config.ahead_bytes).min(plan.total.saturating_sub(1)),
            );
            let last = ahead_limit.min(first + window - 1).min(plan.count().saturating_sub(1));

            (first..=last)
                .filter(|i| !cache.has(*i) && !inflight.contains(i))
                .take(session.config.prefetch_workers)
                .collect()
        };

        if missing.is_empty() {
            tokio::time::sleep(Duration::from_millis(25)).await;
            continue;
        }

        let mut tasks = Vec::with_capacity(missing.len());
        for idx in missing {
            let s = session.clone();
            tasks.push(tokio::spawn(async move {
                let _ = s.chunk(idx).await;
            }));
        }
        for t in tasks {
            let _ = t.await;
        }

        // A seek during the batch makes the rest of that window irrelevant; the
        // next iteration re-reads the playhead and re-targets automatically.
    }
}

async fn stats_loop(session: Arc<StreamSession>) {
    let interval = Duration::from_millis(session.config.stats_interval_ms.max(50));
    loop {
        tokio::time::sleep(interval).await;
        if session.stop.load(Ordering::Relaxed) {
            return;
        }
        (session.sink)(EngineEvent::StreamStats(session.stats()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_limit_keeps_the_window_inside_the_budget() {
        let c = StreamConfig::default().with_cache_limit(50 * 1024 * 1024);
        assert!(
            c.ahead_bytes + c.behind_bytes <= c.cache_limit,
            "the prefetch window must fit in the cache or it would evict itself"
        );

        // A silly-small setting must be clamped, not honoured into a deadlock.
        let c = StreamConfig::default().with_cache_limit(1024);
        assert!(c.cache_limit >= 4 * 1024 * 1024);
    }

}
