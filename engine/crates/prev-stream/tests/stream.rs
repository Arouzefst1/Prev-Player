//! End-to-end streaming tests.
//!
//! The claims under test are the ones the whole architecture rests on: playback
//! without downloading, constant memory regardless of media size, zero disk use
//! unless asked, and a save that turns into a resumable download.

use prev_core::{null_sink, EventLog, ShareLink, TransferState};
use prev_download::{DownloadConfig, DownloadEngine, StateStore};
use prev_share::ShareServer;
use prev_stream::session::SaveOutcome;
use prev_stream::{StreamConfig, StreamServer, StreamSession};
use prev_transport::{HttpTransport, Transport};
use std::path::PathBuf;
use std::sync::Arc;

struct Fixture {
    dir: PathBuf,
    dl: PathBuf,
    data: Vec<u8>,
    link: ShareLink,
    server: ShareServer,
}

impl Fixture {
    fn new(tag: &str, size: usize, chunk_size: u32) -> Self {
        let dir = std::env::temp_dir().join(format!("prev-stream-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dl = dir.join("saved");
        std::fs::create_dir_all(&dl).unwrap();

        let mut state = 0x9E3779B9u32;
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
        let mut link = server.share_file(&src).unwrap();
        link.chunk_size = chunk_size;
        Self { dir, dl, data, link, server }
    }

    fn session(&self, config: StreamConfig) -> Arc<StreamSession> {
        let transport = Arc::new(HttpTransport::new(&self.link.url).unwrap());
        let s = StreamSession::new("s1", &self.link, transport, config, null_sink()).unwrap();
        s.spawn_background();
        s
    }

    fn saved_files(&self) -> Vec<String> {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reads_return_exact_bytes_across_chunk_boundaries() {
    let fx = Fixture::new("reads", 300_000, 64 * 1024);
    let session = fx.session(StreamConfig::default());

    for (offset, len) in [(0usize, 10usize), (65_530, 20), (100_000, 70_000), (299_990, 50)] {
        let got = session.read_at(offset as u64, len).await.unwrap();
        let end = (offset + len).min(fx.data.len());
        assert_eq!(got, &fx.data[offset..end], "mismatch reading {len} bytes at {offset}");
    }

    // Reading past the end yields nothing rather than erroring.
    assert!(session.read_at(fx.data.len() as u64, 100).await.unwrap().is_empty());
    session.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_player_can_stream_the_whole_file_over_local_http() {
    let fx = Fixture::new("http", 1_000_000, 64 * 1024);
    let session = fx.session(StreamConfig::default());
    let server = StreamServer::start(tokio::runtime::Handle::current()).unwrap();
    let url = server.publish(session.clone());

    // Read it back the way a player would: stat, then ranged reads.
    let client = HttpTransport::new(&url).unwrap();
    let meta = client.stat().await.unwrap();
    assert_eq!(meta.size, fx.data.len() as u64);
    assert!(meta.supports_ranges, "the player must be able to seek");

    let mut assembled = Vec::new();
    let mut buf = Vec::new();
    let step = 128 * 1024u64;
    let mut off = 0u64;
    while off < meta.size {
        let len = step.min(meta.size - off) as u32;
        client.read_range(off, len, &mut buf).await.unwrap();
        assembled.extend_from_slice(&buf);
        off += len as u64;
    }
    assert_eq!(assembled, fx.data, "streamed bytes must match the source exactly");

    server.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_far_larger_than_the_cache_streams_in_constant_memory() {
    // 16 MB of media through a 4 MB cache. If anything accumulated, this would
    // hold the whole file.
    let fx = Fixture::new("memory", 16 * 1024 * 1024, 256 * 1024);
    let config = StreamConfig {
        prefetch_workers: 3,
        ..StreamConfig::default().with_cache_limit(4 * 1024 * 1024)
    };
    let limit = config.cache_limit;
    let session = fx.session(config);

    let mut peak = 0u64;
    let mut off = 0u64;
    let total = fx.data.len() as u64;
    while off < total {
        let len = (512 * 1024).min(total - off) as usize;
        let got = session.read_at(off, len).await.unwrap();
        assert_eq!(got, &fx.data[off as usize..off as usize + len]);
        let stats = session.stats();
        peak = peak.max(stats.cached_bytes);
        assert!(
            stats.cached_bytes <= limit,
            "cache exceeded its limit at offset {off}: {} > {limit}",
            stats.cached_bytes
        );
        off += len as u64;
    }

    assert!(peak > 0, "something must actually be buffered");
    assert!(
        peak <= limit,
        "peak memory {peak} exceeded the {limit} byte budget for a {total} byte file"
    );

    // Playing 16 MB must not have written a single byte to disk.
    assert!(fx.saved_files().is_empty(), "Watch Online must not touch the disk");
    session.close();
    assert_eq!(session.stats().cached_bytes, 0, "closing frees the buffer");
}

/// Regression: a big file gets a big chunk size, and a modest cache then holds
/// only a handful of chunks. If eviction picks the wrong victim the prefetcher
/// evicts the chunk it is about to need, re-fetches it, evicts the next one,
/// and the stream fetches the file many times over while the player starves.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tight_cache_does_not_thrash() {
    let total = 8 * 1024 * 1024usize;
    let fx = Fixture::new("thrash", total, 1024 * 1024); // 8 chunks of 1 MB
    let config = StreamConfig {
        // Room for only 4 chunks — the shape that broke a 26 GB file at 64 MB.
        cache_limit: 4 * 1024 * 1024,
        ahead_bytes: 3 * 1024 * 1024,
        behind_bytes: 1024 * 1024,
        prefetch_workers: 3,
        ..Default::default()
    };
    let session = fx.session(config);

    // Park the playhead mid-file, the way a player does while it demuxes.
    // This is the shape that matters: one chunk of history behind the playhead
    // plus the prefetch window ahead of it wants more slots than the cache has,
    // so every insert has to evict something.
    for off in [0u64, 1_048_576, 2_097_152, 3_145_728, 4_194_304] {
        session.read_at(off, 64 * 1024).await.unwrap();
    }

    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let settled = session.stats().fetches;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let later = session.stats().fetches;

    // Once the window around a parked playhead is full, there is nothing left
    // to fetch. If the count keeps climbing, eviction is throwing away the very
    // chunks the prefetcher just asked for.
    assert_eq!(
        settled, later,
        "prefetcher kept re-fetching against a parked playhead ({settled} -> {later}): the cache is thrashing"
    );
    let chunks = session.plan().count() as u64;
    assert!(
        later <= chunks,
        "fetched {later} chunks for a {chunks}-chunk file without the playhead moving"
    );
    session.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_small_rewind_is_served_from_memory_but_a_long_seek_refetches() {
    let fx = Fixture::new("seek", 4 * 1024 * 1024, 128 * 1024);
    let config = StreamConfig {
        behind_bytes: 512 * 1024,
        ahead_bytes: 512 * 1024,
        cache_limit: 2 * 1024 * 1024,
        prefetch_workers: 2,
        ..Default::default()
    };
    let session = fx.session(config);

    // Play forward a little.
    session.read_at(0, 64 * 1024).await.unwrap();
    session.read_at(256 * 1024, 64 * 1024).await.unwrap();
    let after_play = session.stats().fetches;

    // Rewind inside the retained window: no new fetches.
    let got = session.read_at(10_000, 1_000).await.unwrap();
    assert_eq!(got, &fx.data[10_000..11_000]);
    assert_eq!(
        session.stats().fetches,
        after_play,
        "a short rewind must come from the buffer, not the network"
    );

    // Seek far away: that data cannot be resident, so it must be fetched.
    let far = 3 * 1024 * 1024u64;
    let got = session.read_at(far, 1_000).await.unwrap();
    assert_eq!(got, &fx.data[far as usize..far as usize + 1_000]);
    assert!(
        session.stats().fetches > after_play,
        "a long seek has to fetch"
    );
    session.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn save_offline_mid_playback_becomes_a_resumable_download() {
    let fx = Fixture::new("save", 2 * 1024 * 1024, 128 * 1024);
    let log = EventLog::new();
    let store = Arc::new(StateStore::open_in_memory().unwrap());

    let transport = Arc::new(HttpTransport::new(&fx.link.url).unwrap());
    let session = StreamSession::new(
        "s-save",
        &fx.link,
        transport,
        StreamConfig::default().with_cache_limit(4 * 1024 * 1024),
        log.sink(),
    )
    .unwrap();

    // Watch the first quarter without saving — those bytes are gone.
    session.read_at(0, 256 * 1024).await.unwrap();

    // User presses Save Offline part-way through.
    let save_id = session.start_saving(&fx.dl, store.clone()).unwrap();
    assert!(session.is_saving());

    // Keep watching to the end; everything from here is written as it arrives.
    let total = fx.data.len() as u64;
    let mut off = 256 * 1024u64;
    while off < total {
        let len = (256 * 1024).min(total - off) as usize;
        session.read_at(off, len).await.unwrap();
        off += len as u64;
    }

    let outcome = session.stop_saving().unwrap();
    session.close();

    // The saved file has gaps (the part watched before saving started), so the
    // stream hands it to the download engine rather than claiming completion.
    let (id, done, total_chunks) = match outcome {
        SaveOutcome::Resumable { id, chunks_done, chunks_total } => (id, chunks_done, chunks_total),
        SaveOutcome::Completed { id, .. } => (id, 0, 0),
        SaveOutcome::NotSaving => panic!("the session was saving"),
    };
    assert_eq!(id, save_id);
    if total_chunks > 0 {
        assert!(done > 0, "watching must have contributed most of the file");
        assert!(done < total_chunks, "the pre-save portion should still be missing");
    }

    // Finish it: only the gaps are fetched.
    let engine = DownloadEngine::new(
        store.clone(),
        log.sink(),
        DownloadConfig { workers: 4, progress_interval_ms: 20, ..Default::default() },
    );
    engine.resume(&save_id).unwrap();
    assert_eq!(engine.wait(&save_id).await.unwrap(), TransferState::Completed);

    let files = fx.saved_files();
    assert_eq!(files, vec!["Movie.mkv"], "no .partial may survive: {files:?}");
    assert_eq!(
        std::fs::read(fx.dl.join("Movie.mkv")).unwrap(),
        fx.data,
        "the saved file must be byte-identical to the source"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_from_the_start_completes_without_any_extra_download() {
    let fx = Fixture::new("savefull", 1024 * 1024, 128 * 1024);
    let store = Arc::new(StateStore::open_in_memory().unwrap());
    let session = fx.session(StreamConfig::default().with_cache_limit(8 * 1024 * 1024));

    session.start_saving(&fx.dl, store.clone()).unwrap();
    let total = fx.data.len() as u64;
    let mut off = 0u64;
    while off < total {
        let len = (128 * 1024).min(total - off) as usize;
        session.read_at(off, len).await.unwrap();
        off += len as u64;
    }

    match session.stop_saving().unwrap() {
        SaveOutcome::Completed { path, .. } => {
            assert_eq!(std::fs::read(&path).unwrap(), fx.data);
        }
        other => panic!("watching the whole file should complete the save, got {other:?}"),
    }
    assert_eq!(fx.saved_files(), vec!["Movie.mkv"]);
    session.close();
}

/// Regression: the playback endpoint must always send Content-Length. mpv
/// derives the file size from it, and without a size it refuses every seek —
/// which for an MKV (whose cues live at the end) means it will not play at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_playback_endpoint_never_uses_chunked_encoding() {
    use std::io::{Read, Write};

    // Well over tiny_http's 32 KB chunking threshold.
    let fx = Fixture::new("chunked", 400_000, 64 * 1024);
    let server = StreamServer::start(tokio::runtime::Handle::current()).unwrap();
    let session = fx.session(StreamConfig::default());
    let url = server.publish(session.clone());

    for extra in ["", "Range: bytes=0-\r\n", "Range: bytes=100000-399999\r\n"] {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n").unwrap();

        let mut raw = Vec::new();
        let mut byte = [0u8; 1];
        while raw.len() < 8192 {
            match s.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => raw.push(byte[0]),
            }
            if raw.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let headers = String::from_utf8_lossy(&raw).to_lowercase();
        assert!(
            headers.contains("content-length:"),
            "a player cannot seek without a length:\n{headers}"
        );
        assert!(
            !headers.contains("transfer-encoding: chunked"),
            "chunked encoding hides the size from the player:\n{headers}"
        );
    }

    server.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_a_stream_leaves_no_trace() {
    let fx = Fixture::new("cleanup", 512 * 1024, 64 * 1024);
    let server = StreamServer::start(tokio::runtime::Handle::current()).unwrap();
    let session = fx.session(StreamConfig::default());
    let id = session.id().to_string();
    server.publish(session.clone());

    session.read_at(0, 200_000).await.unwrap();
    assert!(session.stats().cached_bytes > 0);

    server.remove(&id);
    assert_eq!(session.stats().cached_bytes, 0, "the buffer is freed on close");
    assert!(server.active().is_empty());
    assert!(fx.saved_files().is_empty(), "streaming leaves nothing on disk");

    server.shutdown();
}
