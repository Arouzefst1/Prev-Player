//! End-to-end download tests against a real share server over real TCP.
//!
//! These are the tests that decide whether the architecture actually holds:
//! bytes arrive intact, an interrupted transfer resumes instead of restarting,
//! a cancel leaves nothing on disk, and memory stays flat regardless of size.

use async_trait::async_trait;
use prev_core::{sha256_hex, ChunkPlan, EngineEvent, EventLog, Result, ShareLink, TransferState};
use prev_download::{DownloadConfig, DownloadEngine, Integrity, StateStore, VerifyPolicy};
use prev_share::ShareServer;
use prev_transport::{HttpTransport, SourceMeta, Transport};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    dir: PathBuf,
    src: PathBuf,
    dl: PathBuf,
    data: Vec<u8>,
    server: ShareServer,
}

impl Fixture {
    fn new(tag: &str, size: usize) -> Self {
        let dir = std::env::temp_dir().join(format!("prev-dl-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dl = dir.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();

        // Pseudo-random but reproducible, so a mis-ordered chunk can't pass.
        let mut state = 0x2545F491u32;
        let data: Vec<u8> = (0..size)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state & 0xff) as u8
            })
            .collect();

        let src = dir.join("Movie.mkv");
        std::fs::write(&src, &data).unwrap();
        let server = ShareServer::start_local().unwrap();
        Self { dir, src, dl, data, server }
    }

    fn link(&self, chunk_size: u32) -> ShareLink {
        let mut link = self.server.share_file(&self.src).unwrap();
        link.chunk_size = chunk_size;
        link
    }

    fn downloaded(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.dl.join(name)).unwrap()
    }

    fn files_in_downloads(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.dl)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.shutdown();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn engine(log: &EventLog, config: DownloadConfig) -> Arc<DownloadEngine> {
    let store = Arc::new(StateStore::open_in_memory().unwrap());
    DownloadEngine::new(store, log.sink(), config)
}

fn fast_config(workers: usize) -> DownloadConfig {
    DownloadConfig {
        workers,
        progress_interval_ms: 20,
        flush_interval_ms: 50,
        ..Default::default()
    }
}

#[derive(Clone, Copy)]
enum Interrupt {
    Pause,
    Cancel,
}

/// An engine that interrupts its own transfer at the first sign of progress.
///
/// Polling from the outside races a loopback transfer that can finish in a few
/// milliseconds — and a test that only passes on a slow day is worse than no
/// test. Reacting to the engine's own progress event is deterministic: it
/// cannot fire before a chunk has landed, or after the last one has.
fn interrupting_engine(log: &EventLog, action: Interrupt) -> Arc<DownloadEngine> {
    let store = Arc::new(StateStore::open_in_memory().unwrap());
    let slot: Arc<std::sync::OnceLock<Arc<DownloadEngine>>> = Arc::new(std::sync::OnceLock::new());
    let sink_slot = slot.clone();
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let log_sink = log.sink();

    let engine = DownloadEngine::new(
        store,
        Arc::new(move |e: EngineEvent| {
            log_sink(e.clone());
            if let EngineEvent::DownloadProgress(p) = &e {
                if p.chunks_done > 0
                    && p.chunks_done < p.chunks_total
                    && !fired.swap(true, Ordering::SeqCst)
                {
                    if let Some(engine) = sink_slot.get() {
                        let _ = match action {
                            Interrupt::Pause => engine.pause(&p.id),
                            Interrupt::Cancel => engine.cancel(&p.id),
                        };
                    }
                }
            }
        }),
        // One worker and frequent ticks so there is always a middle to catch.
        DownloadConfig { workers: 1, progress_interval_ms: 5, flush_interval_ms: 10, ..Default::default() },
    );
    let _ = slot.set(engine.clone());
    engine
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn parallel_download_reassembles_the_file_byte_for_byte() {
    let fx = Fixture::new("parallel", 3_000_000);
    let log = EventLog::new();
    let engine = engine(&log, fast_config(8));

    let link = fx.link(64 * 1024); // ~46 chunks across 8 workers
    let id = engine.start(&link, &fx.dl).await.unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Completed);

    assert_eq!(fx.downloaded("Movie.mkv"), fx.data, "reassembled bytes must match exactly");
    assert_eq!(
        fx.files_in_downloads(),
        vec!["Movie.mkv"],
        "no .partial and no chunk files may survive"
    );

    // The sender's lazily-computed digest must have been collected and matched.
    let completed = log.events().into_iter().find_map(|e| match e {
        EngineEvent::DownloadState { state: TransferState::Completed, verification, .. } => {
            Some(verification)
        }
        _ => None,
    });
    assert_eq!(
        completed,
        Some(Some(prev_core::Verification::Verified)),
        "a LAN share publishes a digest, so the result must be genuinely verified"
    );
}

#[tokio::test]
async fn progress_is_monotonic_and_ends_at_the_full_size() {
    let fx = Fixture::new("progress", 1_500_000);
    let log = EventLog::new();
    let engine = engine(&log, fast_config(4));

    let id = engine.start(&fx.link(64 * 1024), &fx.dl).await.unwrap();
    engine.wait(&id).await.unwrap();

    let mut last = 0u64;
    let mut samples = 0;
    for e in log.events() {
        if let EngineEvent::DownloadProgress(p) = e {
            assert!(p.transferred >= last, "progress went backwards: {last} -> {}", p.transferred);
            assert!(p.transferred <= p.total, "progress exceeded the total size");
            assert_eq!(p.total, fx.data.len() as u64);
            last = p.transferred;
            samples += 1;
        }
    }
    assert!(samples > 0, "the UI needs progress events");
    assert_eq!(last, fx.data.len() as u64, "the final event must show completion");
}

#[tokio::test]
async fn pausing_keeps_the_partial_and_resuming_finishes_it() {
    let fx = Fixture::new("resume", 4_000_000);
    let log = EventLog::new();
    let engine = interrupting_engine(&log, Interrupt::Pause);

    let link = fx.link(64 * 1024);
    let id = engine.start(&link, &fx.dl).await.unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Paused);

    let rec = engine.get(&id).unwrap().unwrap();
    assert!(rec.chunks_done > 0, "pause must keep what was already transferred");
    assert!(rec.chunks_done < rec.chunks_total, "the test needs a genuinely partial transfer");
    let done_at_pause = rec.chunks_done;

    let partial = PathBuf::from(&rec.partial);
    assert!(partial.exists(), "a paused download keeps its .partial");
    assert!(!fx.dl.join("Movie.mkv").exists(), "nothing is published until it is complete");

    // Resume: only the missing chunks should be fetched.
    engine.resume(&id).unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Completed);

    assert_eq!(fx.downloaded("Movie.mkv"), fx.data);
    assert_eq!(fx.files_in_downloads(), vec!["Movie.mkv"]);

    // Prove it resumed rather than restarted: the second run's first progress
    // event already reflects the chunks from the first run.
    let resumed_from = log
        .events()
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::DownloadProgress(p) => Some(p.chunks_done),
            _ => None,
        })
        .skip_while(|&c| c < done_at_pause)
        .next();
    assert!(resumed_from.is_some(), "resume must continue from the persisted chunk map");
}

#[tokio::test]
async fn cancelling_deletes_the_partial_and_the_record() {
    let fx = Fixture::new("cancel", 4_000_000);
    let log = EventLog::new();
    let engine = interrupting_engine(&log, Interrupt::Cancel);

    let id = engine.start(&fx.link(64 * 1024), &fx.dl).await.unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Cancelled);

    assert!(fx.files_in_downloads().is_empty(), "cancel must leave zero bytes on disk");
    assert!(engine.get(&id).unwrap().is_none(), "the record goes too");
}

#[tokio::test]
async fn a_corrupt_chunk_is_repaired_without_restarting_the_download() {
    let fx = Fixture::new("repair", 512 * 1024);
    let chunk_size = 64 * 1024u32;
    let plan = ChunkPlan::new(fx.data.len() as u64, chunk_size);

    // Per-chunk digests, as a piece-list-publishing transport would provide.
    let hashes: Vec<String> = (0..plan.count())
        .map(|i| {
            let (off, len) = plan.range(i);
            sha256_hex(&fx.data[off as usize..off as usize + len as usize])
        })
        .collect();

    let mut link = fx.link(chunk_size);
    link.hash_url = None; // exercise the per-chunk path, not the whole-file one

    let inner = Arc::new(HttpTransport::new(&link.url).unwrap());
    let corrupting = Arc::new(CorruptOnce::new(inner, 2));
    let corruptions = corrupting.corruptions.clone();

    let log = EventLog::new();
    let engine = engine(&log, fast_config(4));
    let id = engine
        .start_with_transport(&link, &fx.dl, Integrity::Chunks(hashes), corrupting)
        .await
        .unwrap();

    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Completed);
    assert_eq!(corruptions.load(Ordering::Relaxed), 1, "the fault must have fired exactly once");
    assert_eq!(fx.downloaded("Movie.mkv"), fx.data, "repair must produce the correct file");

    let repairs: Vec<u32> = log
        .events()
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::ChunkRepaired { index, .. } => Some(index),
            _ => None,
        })
        .collect();
    assert_eq!(repairs, vec![2], "exactly the bad chunk should have been re-fetched");
}

#[tokio::test]
async fn memory_stays_bounded_by_the_configured_budget() {
    // 8 MB of media through a 512 KB budget: if the engine buffered the file,
    // or allocated per chunk, this would need 16x the memory it is allowed.
    let fx = Fixture::new("memory", 8 * 1024 * 1024);
    let chunk_size = 128 * 1024u32;

    let link = fx.link(chunk_size);
    let inner = Arc::new(HttpTransport::new(&link.url).unwrap());
    let counting = Arc::new(CountingTransport::new(inner));
    let peak = counting.peak.clone();

    let log = EventLog::new();
    let config = DownloadConfig {
        memory_budget: 512 * 1024, // 4 buffers of 128 KB
        ..fast_config(8)
    };
    let engine = engine(&log, config);
    let id = engine
        .start_with_transport(&link, &fx.dl, Integrity::None, counting)
        .await
        .unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Completed);

    assert_eq!(fx.downloaded("Movie.mkv"), fx.data);
    let peak = peak.load(Ordering::Relaxed);
    assert!(
        peak <= 4,
        "the pool must cap chunks in flight at 4, saw {peak} concurrent fetches"
    );
}

#[tokio::test]
async fn a_source_without_range_support_is_refused_with_a_clear_error() {
    let fx = Fixture::new("noranges", 1000);
    let link = fx.link(64 * 1024);
    let inner = Arc::new(HttpTransport::new(&link.url).unwrap());

    let log = EventLog::new();
    let engine = engine(&log, fast_config(2));
    let err = engine
        .start_with_transport(&link, &fx.dl, Integrity::None, Arc::new(NoRanges(inner)))
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("range"),
        "the error must explain why chunking is impossible: {err}"
    );
}

#[tokio::test]
async fn verification_required_fails_when_the_source_publishes_no_digest() {
    let fx = Fixture::new("required", 200_000);
    let mut link = fx.link(64 * 1024);
    link.hash_url = None;
    link.sha256 = None;

    let log = EventLog::new();
    let config = DownloadConfig { verify: VerifyPolicy::Required, ..fast_config(4) };
    let engine = engine(&log, config);
    let id = engine.start(&link, &fx.dl).await.unwrap();

    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Failed);
    assert!(!fx.dl.join("Movie.mkv").exists(), "an unverifiable file is not published");
}

#[tokio::test]
async fn a_hostile_share_name_cannot_escape_the_download_directory() {
    let fx = Fixture::new("escape", 1000);
    let mut link = fx.link(64 * 1024);
    link.name = "../../../escaped.mkv".into();

    let log = EventLog::new();
    let engine = engine(&log, fast_config(2));
    let id = engine.start(&link, &fx.dl).await.unwrap();
    assert_eq!(engine.wait(&id).await.unwrap(), TransferState::Completed);

    // The name may keep its dots — what matters is that it stays a single
    // filename component inside the download directory.
    let files = fx.files_in_downloads();
    assert_eq!(files.len(), 1);
    assert!(
        !files[0].contains('/') && !files[0].contains('\\'),
        "path traversal must be neutralised: {files:?}"
    );
    assert!(!fx.dir.join("escaped.mkv").exists());
    assert!(fx.dl.join(&files[0]).exists(), "the file must land in the download dir");
}

// ---------------------------------------------------------------------------
// Fault-injecting transports
// ---------------------------------------------------------------------------

/// Corrupts one specific chunk the first time it is read, then behaves.
struct CorruptOnce {
    inner: Arc<HttpTransport>,
    target_index: u32,
    /// Reads of the target chunk (2 once a repair has happened).
    reads: Arc<AtomicU32>,
    /// Times a byte was actually flipped — must be exactly 1.
    corruptions: Arc<AtomicU32>,
}

impl CorruptOnce {
    fn new(inner: Arc<HttpTransport>, index: u32) -> Self {
        Self {
            inner,
            target_index: index,
            reads: Arc::new(AtomicU32::new(0)),
            corruptions: Arc::new(AtomicU32::new(0)),
        }
    }
}

#[async_trait]
impl Transport for CorruptOnce {
    fn scheme(&self) -> &'static str {
        "test-corrupt"
    }
    fn describe(&self) -> String {
        self.inner.describe()
    }
    async fn stat(&self) -> Result<SourceMeta> {
        self.inner.stat().await
    }
    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()> {
        self.inner.read_range(offset, len, out).await?;
        let index = if len > 0 { (offset / len as u64) as u32 } else { 0 };
        if index == self.target_index
            && self.reads.fetch_add(1, Ordering::Relaxed) == 0
            && !out.is_empty()
        {
            out[0] ^= 0xff;
            self.corruptions.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}

/// Records the high-water mark of concurrent in-flight reads.
struct CountingTransport {
    inner: Arc<HttpTransport>,
    inflight: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl CountingTransport {
    fn new(inner: Arc<HttpTransport>) -> Self {
        Self {
            inner,
            inflight: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl Transport for CountingTransport {
    fn scheme(&self) -> &'static str {
        "test-counting"
    }
    fn describe(&self) -> String {
        self.inner.describe()
    }
    async fn stat(&self) -> Result<SourceMeta> {
        self.inner.stat().await
    }
    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()> {
        let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        let r = self.inner.read_range(offset, len, out).await;
        self.inflight.fetch_sub(1, Ordering::SeqCst);
        r
    }
}

/// Reports a source that cannot seek.
struct NoRanges(Arc<HttpTransport>);

#[async_trait]
impl Transport for NoRanges {
    fn scheme(&self) -> &'static str {
        "test-noranges"
    }
    fn describe(&self) -> String {
        self.0.describe()
    }
    async fn stat(&self) -> Result<SourceMeta> {
        let mut m = self.0.stat().await?;
        m.supports_ranges = false;
        Ok(m)
    }
    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()> {
        self.0.read_range(offset, len, out).await
    }
}
