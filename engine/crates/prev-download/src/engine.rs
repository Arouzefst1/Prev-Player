//! The parallel download engine.
//!
//! ```text
//!            ┌── worker 1 ──┐
//!  chunk     ├── worker 2 ──┤   positional        Movie.mkv.partial
//!  queue ────┼── worker 3 ──┼──── writes ──────►  (one file, preallocated)
//!            └── worker N ──┘
//! ```
//!
//! Workers pull chunk indices from one queue, fetch them through the transport
//! into a pooled buffer, verify, and write straight to that chunk's offset in a
//! single `.partial` file. Nothing is buffered whole, nothing is copied at the
//! end, and the chunk map — flushed to SQLite as it goes — is all that's needed
//! to pick up exactly where an interrupted transfer left off.

use crate::state::{now, DownloadRecord, StateStore};
use crate::verify::{verify_file, Integrity, VerifyOutcome, VerifyPolicy};
use crate::writer::PartialWriter;
use prev_core::{
    sha256_hex, ChunkMap, ChunkPlan, DownloadProgress, EngineError, EngineEvent, EventSink,
    MemoryPool, Result, ShareLink, SpeedMeter, TransferState,
};
use prev_transport::{read_range_retrying, resolve_url, RetryPolicy, Transport};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Notify};

// Cooperative control flag values shared by every worker on a job.
const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;
const FAIL: u8 = 3;

#[derive(Clone, Debug)]
pub struct DownloadConfig {
    /// Parallel workers per download.
    pub workers: usize,
    pub retry: RetryPolicy,
    /// Ceiling on in-flight chunk buffers, in bytes. This *is* the engine's
    /// memory footprint for a download, whatever the media size.
    pub memory_budget: usize,
    pub progress_interval_ms: u64,
    /// How often the chunk map is written to SQLite. Also the worst-case amount
    /// of re-download after a power cut.
    pub flush_interval_ms: u64,
    pub verify: VerifyPolicy,
    /// How long to wait for a sender that is still computing its digest.
    pub digest_wait: Duration,
    /// Give up after this many failed chunk verifications across a job.
    pub max_chunk_repairs: u32,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            workers: default_workers(),
            retry: RetryPolicy::default(),
            memory_budget: 128 * 1024 * 1024,
            progress_interval_ms: 200,
            flush_interval_ms: 1_000,
            verify: VerifyPolicy::default(),
            digest_wait: Duration::from_secs(20),
            max_chunk_repairs: 32,
        }
    }
}

/// Scale with the machine, but stay inside what a LAN peer or a CDN will
/// actually serve faster in parallel — past ~16 streams you add latency, not
/// throughput.
pub fn default_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_mul(2)
        .clamp(4, 16)
}

struct JobHandle {
    control: Arc<AtomicU8>,
    state_tx: watch::Sender<TransferState>,
}

pub struct DownloadEngine {
    store: Arc<StateStore>,
    sink: EventSink,
    config: DownloadConfig,
    jobs: Mutex<HashMap<String, JobHandle>>,
}

impl DownloadEngine {
    pub fn new(store: Arc<StateStore>, sink: EventSink, config: DownloadConfig) -> Arc<Self> {
        Arc::new(Self { store, sink, config, jobs: Mutex::new(HashMap::new()) })
    }

    pub fn store(&self) -> &Arc<StateStore> {
        &self.store
    }

    pub fn config(&self) -> &DownloadConfig {
        &self.config
    }

    /// Queue a download for a resolved share link and start it.
    pub async fn start(self: &Arc<Self>, link: &ShareLink, dest_dir: impl AsRef<Path>) -> Result<String> {
        let integrity = match (&link.sha256, &link.hash_url) {
            (Some(h), _) => Integrity::Whole(h.clone()),
            (None, Some(u)) => Integrity::Deferred { url: u.clone() },
            _ => Integrity::None,
        };
        self.start_with_integrity(link, dest_dir, integrity).await
    }

    /// As [`start`](Self::start), but with a caller-supplied integrity source —
    /// how a transport that publishes a piece-hash list opts into per-chunk
    /// verification and repair.
    pub async fn start_with_integrity(
        self: &Arc<Self>,
        link: &ShareLink,
        dest_dir: impl AsRef<Path>,
        integrity: Integrity,
    ) -> Result<String> {
        let transport = resolve_url(&link.transport, &link.url)?;
        self.start_with_transport(link, dest_dir, integrity, transport).await
    }

    /// As [`start`](Self::start), but against a caller-built transport — the
    /// hook for a source that needs credentials, a shared connection pool, or
    /// an implementation this crate doesn't know about.
    ///
    /// Note that [`resume`](Self::resume) rebuilds the transport from the link,
    /// so a custom one has to be re-supplied to resume such a job.
    pub async fn start_with_transport(
        self: &Arc<Self>,
        link: &ShareLink,
        dest_dir: impl AsRef<Path>,
        integrity: Integrity,
        transport: Arc<dyn Transport>,
    ) -> Result<String> {
        let meta = transport.stat().await?;

        if !meta.supports_ranges {
            return Err(EngineError::NoRangeSupport);
        }
        let total = if link.size > 0 { link.size } else { meta.size };
        if total == 0 {
            return Err(EngineError::Transport(
                "source did not report a size, so it cannot be chunked".into(),
            ));
        }

        let name = if link.name.is_empty() { meta.name.clone() } else { link.name.clone() };
        let plan = if link.chunk_size > 0 {
            ChunkPlan::new(total, link.chunk_size)
        } else {
            ChunkPlan::auto(total)
        };
        let dest = dest_dir.as_ref().join(sanitise(&name));
        let id = new_id(&link.url, &name);

        let rec = DownloadRecord {
            id: id.clone(),
            name: name.clone(),
            url: link.url.clone(),
            transport: link.transport.clone(),
            dest: dest.to_string_lossy().to_string(),
            partial: crate::writer::partial_path(&dest).to_string_lossy().to_string(),
            total,
            chunk_size: plan.chunk_size,
            chunks_total: plan.count(),
            chunks_done: 0,
            state: TransferState::Queued,
            sha256: link.sha256.clone(),
            hash_url: link.hash_url.clone(),
            error: None,
            created_at: now(),
            updated_at: now(),
        };
        let map = ChunkMap::new(plan.count());
        self.store.insert(&rec, &map)?;
        self.launch(rec, map, transport, integrity)?;
        Ok(id)
    }

    /// Restart a paused or failed download from its persisted chunk map.
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        if self.jobs.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        let (rec, map) = self
            .store
            .load(id)?
            .ok_or_else(|| EngineError::State(format!("no download with id {id}")))?;
        if rec.state == TransferState::Completed {
            return Ok(());
        }
        let transport = resolve_url(&rec.transport, &rec.url)?;
        let integrity = match (&rec.sha256, &rec.hash_url) {
            (Some(h), _) => Integrity::Whole(h.clone()),
            (None, Some(u)) => Integrity::Deferred { url: u.clone() },
            _ => Integrity::None,
        };
        self.launch(rec, map, transport, integrity)
    }

    fn launch(
        self: &Arc<Self>,
        rec: DownloadRecord,
        map: ChunkMap,
        transport: Arc<dyn Transport>,
        integrity: Integrity,
    ) -> Result<()> {
        let control = Arc::new(AtomicU8::new(RUN));
        let (state_tx, _) = watch::channel(TransferState::Queued);
        self.jobs.lock().unwrap().insert(
            rec.id.clone(),
            JobHandle { control: control.clone(), state_tx: state_tx.clone() },
        );

        let engine = self.clone();
        tokio::spawn(async move {
            let id = rec.id.clone();
            let name = rec.name.clone();
            let outcome = run_job(&engine, rec, map, transport, integrity, control, &state_tx).await;

            let (state, error, path, verification) = match outcome {
                Ok(JobOutcome::Completed { path, verify }) => (
                    TransferState::Completed,
                    None,
                    Some(path.to_string_lossy().to_string()),
                    Some(verify.as_verification()),
                ),
                Ok(JobOutcome::Paused) => (TransferState::Paused, None, None, None),
                Ok(JobOutcome::Cancelled) => (TransferState::Cancelled, None, None, None),
                Err(e) => (TransferState::Failed, Some(e.to_string()), None, None),
            };

            if state == TransferState::Cancelled {
                let _ = engine.store.remove(&id);
            } else {
                let _ = engine.store.set_state(&id, state, error.as_deref());
            }
            (engine.sink)(EngineEvent::DownloadState {
                id: id.clone(),
                name,
                state,
                error,
                path,
                verification,
            });
            // Publish the terminal state before dropping the handle, so anyone
            // awaiting `wait()` sees it.
            let _ = state_tx.send(state);
            engine.jobs.lock().unwrap().remove(&id);
        });
        Ok(())
    }

    /// Stop transferring but keep the partial file — resumable.
    pub fn pause(&self, id: &str) -> Result<()> {
        self.signal(id, PAUSE)
    }

    /// Stop transferring and delete the partial file and the record.
    pub fn cancel(&self, id: &str) -> Result<()> {
        if self.signal(id, CANCEL).is_err() {
            // Not running: clean up the on-disk remains directly.
            if let Some((rec, _)) = self.store.load(id)? {
                let _ = std::fs::remove_file(&rec.partial);
                self.store.remove(id)?;
                (self.sink)(EngineEvent::DownloadState {
                    id: id.to_string(),
                    name: rec.name,
                    state: TransferState::Cancelled,
                    error: None,
                    path: None,
                    verification: None,
                });
            }
        }
        Ok(())
    }

    fn signal(&self, id: &str, value: u8) -> Result<()> {
        match self.jobs.lock().unwrap().get(id) {
            Some(h) => {
                h.control.store(value, Ordering::Relaxed);
                Ok(())
            }
            None => Err(EngineError::State(format!("download {id} is not running"))),
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.jobs.lock().unwrap().contains_key(id)
    }

    pub fn list(&self) -> Result<Vec<DownloadRecord>> {
        Ok(self.store.all()?.into_iter().map(|(r, _)| r).collect())
    }

    pub fn get(&self, id: &str) -> Result<Option<DownloadRecord>> {
        Ok(self.store.load(id)?.map(|(r, _)| r))
    }

    /// Block until the download reaches a terminal state.
    pub async fn wait(&self, id: &str) -> Result<TransferState> {
        let mut rx = match self.jobs.lock().unwrap().get(id) {
            Some(h) => h.state_tx.subscribe(),
            None => {
                return Ok(self
                    .store
                    .load(id)?
                    .map(|(r, _)| r.state)
                    .unwrap_or(TransferState::Cancelled))
            }
        };
        loop {
            let state = *rx.borrow_and_update();
            if state.is_terminal() {
                return Ok(state);
            }
            if rx.changed().await.is_err() {
                // Sender dropped: the job finished, so trust the store.
                return Ok(self
                    .store
                    .load(id)?
                    .map(|(r, _)| r.state)
                    .unwrap_or(TransferState::Cancelled));
            }
        }
    }
}

enum JobOutcome {
    Completed { path: PathBuf, verify: VerifyOutcome },
    Paused,
    Cancelled,
}

/// Everything a worker needs, in one allocation.
struct JobCtx {
    id: String,
    name: String,
    plan: ChunkPlan,
    transport: Arc<dyn Transport>,
    file: Arc<std::fs::File>,
    pool: Arc<MemoryPool>,
    map: Mutex<ChunkMap>,
    queue: Mutex<VecDeque<u32>>,
    control: Arc<AtomicU8>,
    integrity: Integrity,
    retry: RetryPolicy,
    error: Mutex<Option<String>>,
    repairs: AtomicU32,
    max_repairs: u32,
    active: AtomicUsize,
    sink: EventSink,
}

impl JobCtx {
    /// Record the first error and stop every other worker on this job.
    fn fail(&self, msg: String) {
        let mut slot = self.error.lock().unwrap();
        if slot.is_none() {
            *slot = Some(msg);
        }
        self.control.store(FAIL, Ordering::Relaxed);
    }
}

async fn run_job(
    engine: &Arc<DownloadEngine>,
    rec: DownloadRecord,
    map: ChunkMap,
    transport: Arc<dyn Transport>,
    integrity: Integrity,
    control: Arc<AtomicU8>,
    state_tx: &watch::Sender<TransferState>,
) -> Result<JobOutcome> {
    let cfg = engine.config.clone();
    let plan = ChunkPlan::new(rec.total, rec.chunk_size);
    let writer = PartialWriter::open(&rec.dest, rec.total)?;

    engine.store.set_state(&rec.id, TransferState::Running, None)?;
    let _ = state_tx.send(TransferState::Running);
    (engine.sink)(EngineEvent::DownloadState {
        id: rec.id.clone(),
        name: rec.name.clone(),
        state: TransferState::Running,
        error: None,
        path: None,
        verification: None,
    });

    let queue: VecDeque<u32> = map.missing().collect();
    let worker_count = cfg.workers.min(queue.len().max(1));

    let ctx = Arc::new(JobCtx {
        id: rec.id.clone(),
        name: rec.name.clone(),
        plan,
        transport,
        file: writer.file(),
        pool: MemoryPool::with_budget(plan.chunk_size as usize, cfg.memory_budget),
        map: Mutex::new(map),
        queue: Mutex::new(queue),
        control: control.clone(),
        integrity: integrity.clone(),
        retry: cfg.retry,
        error: Mutex::new(None),
        repairs: AtomicU32::new(0),
        max_repairs: cfg.max_chunk_repairs,
        active: AtomicUsize::new(0),
        sink: engine.sink.clone(),
    });

    // The reporter is stopped by signal, not aborted, so that every task has
    // released its handle on the partial file before we rename it.
    let stop = Arc::new(Notify::new());
    let reporter = tokio::spawn(reporter_loop(
        ctx.clone(),
        engine.store.clone(),
        stop.clone(),
        cfg.progress_interval_ms,
        cfg.flush_interval_ms,
        worker_count,
    ));

    let mut workers = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        workers.push(tokio::spawn(worker_loop(ctx.clone())));
    }
    for w in workers {
        let _ = w.await;
    }
    stop.notify_waiters();
    let _ = reporter.await;

    let final_map = ctx.map.lock().unwrap().clone();
    engine.store.save_progress(&rec.id, &final_map)?;
    emit_progress(&ctx, &final_map, 0, 0, None);

    let control_value = control.load(Ordering::Relaxed);
    let error = ctx.error.lock().unwrap().clone();
    drop(ctx); // release the last worker-side handle on the partial file

    match control_value {
        CANCEL => {
            writer.discard()?;
            return Ok(JobOutcome::Cancelled);
        }
        PAUSE => {
            writer.flush()?;
            return Ok(JobOutcome::Paused);
        }
        FAIL => {
            writer.flush()?;
            return Err(EngineError::Other(
                error.unwrap_or_else(|| "download failed".into()),
            ));
        }
        _ => {}
    }

    if !final_map.is_complete() {
        writer.flush()?;
        return Err(EngineError::Other(format!(
            "download ended with {} of {} chunks missing",
            final_map.count() - final_map.done(),
            final_map.count()
        )));
    }

    // ---- verification -----------------------------------------------------
    let verify = if cfg.verify == VerifyPolicy::Off {
        VerifyOutcome::Skipped
    } else {
        engine.store.set_state(&rec.id, TransferState::Verifying, None)?;
        let _ = state_tx.send(TransferState::Verifying);
        (engine.sink)(EngineEvent::DownloadState {
            id: rec.id.clone(),
            name: rec.name.clone(),
            state: TransferState::Verifying,
            error: None,
            path: None,
            verification: None,
        });
        writer.flush()?;
        match integrity.resolve_whole(cfg.digest_wait).await {
            Some(expected) => {
                verify_file(writer.partial_path(), &expected).await?;
                let _ = engine.store.set_sha256(&rec.id, &expected);
                VerifyOutcome::Verified { sha256: expected }
            }
            None if cfg.verify == VerifyPolicy::Required => {
                return Err(EngineError::Other(
                    "the source published no checksum and verification is required".into(),
                ))
            }
            None if integrity.has_per_chunk() => VerifyOutcome::Verified {
                sha256: "per-chunk".into(),
            },
            None => VerifyOutcome::SizeOnly,
        }
    };

    let path = writer.finish()?;
    Ok(JobOutcome::Completed { path, verify })
}

async fn worker_loop(ctx: Arc<JobCtx>) {
    ctx.active.fetch_add(1, Ordering::Relaxed);
    loop {
        if ctx.control.load(Ordering::Relaxed) != RUN {
            break;
        }
        let Some(idx) = ctx.queue.lock().unwrap().pop_front() else {
            break;
        };
        let (offset, len) = ctx.plan.range(idx);
        if len == 0 {
            continue;
        }

        let mut buf = ctx.pool.acquire().await;
        {
            let vec = buf.as_mut_vec();
            if let Err(e) =
                read_range_retrying(ctx.transport.as_ref(), offset, len, vec, ctx.retry).await
            {
                ctx.fail(format!("chunk {idx}: {e}"));
                break;
            }
        }

        if ctx.integrity.verify_chunk(idx, buf.as_slice()).is_err() {
            // Repair in place: this one chunk goes back on the queue and
            // everything already on disk is untouched.
            let n = ctx.repairs.fetch_add(1, Ordering::Relaxed) + 1;
            (ctx.sink)(EngineEvent::ChunkRepaired { id: ctx.id.clone(), index: idx });
            if n > ctx.max_repairs {
                ctx.fail(format!("chunk {idx} kept failing verification"));
                break;
            }
            ctx.queue.lock().unwrap().push_back(idx);
            continue;
        }

        let owned = std::mem::take(buf.as_mut_vec());
        let file = ctx.file.clone();
        let write = tokio::task::spawn_blocking(move || {
            let r = prev_core::posio::pwrite_all(&file, &owned, offset);
            (r, owned)
        })
        .await;

        match write {
            Ok((Ok(()), owned)) => {
                *buf.as_mut_vec() = owned;
                ctx.map.lock().unwrap().set(idx);
            }
            Ok((Err(e), _)) => {
                ctx.fail(format!("writing chunk {idx}: {e}"));
                break;
            }
            Err(e) => {
                ctx.fail(format!("write task for chunk {idx} panicked: {e}"));
                break;
            }
        }
    }
    ctx.active.fetch_sub(1, Ordering::Relaxed);
}

async fn reporter_loop(
    ctx: Arc<JobCtx>,
    store: Arc<StateStore>,
    stop: Arc<Notify>,
    progress_ms: u64,
    flush_ms: u64,
    workers: usize,
) {
    let initial = { ctx.map.lock().unwrap().bytes_done(&ctx.plan) };
    let mut meter = SpeedMeter::new(initial);
    let mut last_flush = Instant::now();

    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(progress_ms)) => {}
            _ = stop.notified() => break,
        }

        let snapshot = { ctx.map.lock().unwrap().clone() };
        let done_bytes = snapshot.bytes_done(&ctx.plan);
        let bps = meter.sample(done_bytes);
        let eta = meter.eta(ctx.plan.total.saturating_sub(done_bytes));
        emit_progress(&ctx, &snapshot, bps as u64, workers, eta);

        if last_flush.elapsed() >= Duration::from_millis(flush_ms) {
            let _ = store.save_progress(&ctx.id, &snapshot);
            last_flush = Instant::now();
        }
    }
}

fn emit_progress(ctx: &JobCtx, map: &ChunkMap, bps: u64, workers: usize, eta: Option<u64>) {
    (ctx.sink)(EngineEvent::DownloadProgress(DownloadProgress {
        id: ctx.id.clone(),
        name: ctx.name.clone(),
        transferred: map.bytes_done(&ctx.plan),
        total: ctx.plan.total,
        speed_bps: bps,
        eta_secs: eta,
        chunks_done: map.done(),
        chunks_total: map.count(),
        workers,
    }));
}

fn new_id(url: &str, name: &str) -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    sha256_hex(format!("{url}|{name}|{t}").as_bytes())[..16].to_string()
}

/// Strip anything that can't be a filename, and refuse path separators so a
/// hostile share name can't write outside the download directory.
pub fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    // Trailing dots are stripped (Windows silently drops them), but a *leading*
    // dot is part of the name — blanket-trimming turned ".mkv" into "mkv" and
    // saved a video with no extension. Only the traversal names are rejected.
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "download".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitise_blocks_path_escapes() {
        assert_eq!(sanitise("Movie.mkv"), "Movie.mkv");
        // Dots may survive — what makes traversal impossible is that every
        // separator is neutralised, so the result is a single filename
        // component and can only land inside the download directory.
        assert_eq!(sanitise("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitise("C:\\Windows\\evil.exe"), "C__Windows_evil.exe");
        assert_eq!(sanitise("   "), "download");
        assert_eq!(sanitise(".."), "download");
        assert_eq!(sanitise("."), "download");
        // A leading dot is part of the filename; stripping it loses the
        // extension and saves a video as an unopenable "mkv".
        assert_eq!(sanitise(".mkv"), ".mkv");
        assert_eq!(sanitise("Movie.mkv."), "Movie.mkv");
        for hostile in ["../x", "..\\x", "/etc/x", "C:/x"] {
            let s = sanitise(hostile);
            assert!(!s.contains('/') && !s.contains('\\'), "{hostile} -> {s}");
        }
    }

    #[test]
    fn worker_count_is_sane_on_any_machine() {
        let n = default_workers();
        assert!((4..=16).contains(&n), "unexpected worker count: {n}");
    }

    #[test]
    fn ids_are_unique_per_start() {
        let a = new_id("http://h/s/1", "Movie.mkv");
        let b = new_id("http://h/s/1", "Movie.mkv");
        assert_ne!(a, b);
        assert_eq!(a.len(), 16);
    }
}
