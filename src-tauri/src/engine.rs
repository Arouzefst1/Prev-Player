// ===========================================================================
// The transfer engine, wired into Tauri.
//
// Everything that moves bytes between devices — LAN sharing, streaming a remote
// file straight into mpv, and parallel verified downloads — is one
// `prev_engine::Engine` held in managed state. Each command here is a thin
// translation of an engine method into what the UI speaks; the engine itself
// knows nothing about Tauri, and this file holds no transfer logic of its own.
//
// One event channel comes back out: `prev-engine`, carrying progress, state
// changes and buffer stats for every transfer and stream at once.
// ===========================================================================

use prev_core::EngineEvent;
use prev_engine::{Engine, EngineConfig, ResolvedShare, WatchHandle};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct EngineState {
    engine: Arc<Engine>,
    /// Resolved shares, keyed by the link text the UI resolved. A folder
    /// manifest is fetched once and every later call (watch item 3, download
    /// items 1..n) is offline. It also keeps the per-file `ShareLink`s on this
    /// side of the bridge — they carry chunk grids and digest URLs that have no
    /// business being rebuilt in JS.
    resolved: Mutex<HashMap<String, ResolvedShare>>,
}

impl EngineState {
    /// Cached resolve. The lock is never held across the await.
    async fn resolve(&self, link: &str) -> Result<ResolvedShare, String> {
        if let Some(hit) = self.resolved.lock().unwrap().get(link) {
            return Ok(hit.clone());
        }
        let share = self.engine.resolve(link).await.map_err(|e| e.to_string())?;
        self.resolved
            .lock()
            .unwrap()
            .insert(link.to_string(), share.clone());
        Ok(share)
    }

    /// The link for one entry of a share: `index` picks a file out of a folder
    /// share, and is ignored for a single-file one.
    async fn file_link(&self, link: &str, index: Option<usize>) -> Result<prev_core::ShareLink, String> {
        let share = self.resolve(link).await?;
        let i = index.unwrap_or(0);
        share
            .files
            .get(i)
            .map(|f| f.link.clone())
            .ok_or_else(|| format!("this share has no file #{i}"))
    }
}

// ---------------------------------------------------------------------------
// Tuning the user can change (persisted next to the transfer state)
// ---------------------------------------------------------------------------

/// Read at startup, so a change takes effect on the next launch. Streaming
/// sessions bake their buffer geometry in when they are created, and rebuilding
/// the engine underneath a running transfer would be a worse trade than waiting.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tuning {
    /// RAM ceiling for one streaming session, in MB.
    pub stream_cache_mb: u64,
    /// Parallel workers per download; 0 means "decide from the CPU count".
    pub download_workers: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Self { stream_cache_mb: 256, download_workers: 0 }
    }
}

fn tuning_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("engine.json"))
}

fn read_tuning(app: &AppHandle) -> Tuning {
    tuning_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Build the engine and hand it to Tauri's state. Called once from `setup`.
///
/// `Engine::start` needs a multi-threaded tokio runtime because the playback
/// endpoint blocks its own OS threads on async reads — hence `block_on` on
/// Tauri's global runtime rather than a plain call.
pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;

    let tuning = read_tuning(app);
    let mut config = EngineConfig {
        state_db: dir.join("transfers.db"),
        ..Default::default()
    };
    config.stream = config
        .stream
        .with_cache_limit(tuning.stream_cache_mb * 1024 * 1024);
    if tuning.download_workers > 0 {
        config.download.workers = tuning.download_workers.min(16);
    }

    // Every progress tick, state change and buffer stat becomes one event on a
    // single channel; the frontend switches on `kind`.
    let sink_app = app.clone();
    let sink: prev_core::EventSink = Arc::new(move |event: EngineEvent| {
        let _ = sink_app.emit("prev-engine", event);
    });

    let engine = tauri::async_runtime::block_on(async move { Engine::start(config, sink) })?;

    app.manage(EngineState { engine, resolved: Mutex::new(HashMap::new()) });
    Ok(())
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    /// Revocation handle — pass it back to `engine_stop_share`.
    pub id: String,
    /// The `prev://…` link to hand to the receiver.
    pub link: String,
    pub name: String,
    pub size: u64,
    pub file_count: usize,
}

/// The share id is the path segment the server routes on: `/s/<id>` for a file,
/// `/f/<id>` for a folder.
fn share_id_of(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Run an engine call that blocks, somewhere it is allowed to.
///
/// **Tauri executes a non-`async` command on the main thread**, which is the UI
/// thread — and several of these hit SQLite, finalise a file, or flush the whole
/// resident stream buffer to disk. Doing that inline stops the window pumping
/// messages, and Windows kills it as `AppHangB1` rather than waiting. So every
/// command below is `async` (never scheduled on the main thread) and the work
/// itself goes to a blocking thread rather than parking an async worker.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("engine task failed: {e}"))?
}

#[tauri::command]
pub async fn engine_share_file(
    state: State<'_, EngineState>,
    path: String,
) -> Result<Published, String> {
    let engine = state.engine.clone();
    blocking(move || {
        let link = engine.share_file(&path).map_err(|e| e.to_string())?;
        Ok(Published {
            id: share_id_of(&link.url),
            link: link.encode(),
            name: link.name.clone(),
            size: link.size,
            file_count: 1,
        })
    })
    .await
}

#[tauri::command]
pub async fn engine_share_folder(
    state: State<'_, EngineState>,
    paths: Vec<String>,
    folder_name: String,
) -> Result<Published, String> {
    let engine = state.engine.clone();
    blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let link = engine
            .share_folder(&paths, &folder_name)
            .map_err(|e| e.to_string())?;
        Ok(Published {
            id: share_id_of(&link.url),
            link: link.encode(),
            name: link.name.clone(),
            size: link.size,
            file_count: link.files.as_ref().map(|f| f.len()).unwrap_or(1),
        })
    })
    .await
}

#[tauri::command]
pub async fn engine_stop_share(state: State<'_, EngineState>, id: String) -> Result<bool, String> {
    Ok(state.engine.stop_share(&id))
}

#[tauri::command]
pub async fn engine_stop_all_shares(state: State<'_, EngineState>) -> Result<(), String> {
    state.engine.stop_all_shares();
    Ok(())
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFileDto {
    /// Position in the share — the handle for `engine_watch` / `engine_download`.
    pub index: usize,
    pub name: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDto {
    /// Echoed back so the UI has one opaque handle to pass to later calls.
    pub link: String,
    pub name: String,
    pub kind: String,
    pub total_size: u64,
    pub transport: String,
    /// False means the source refuses range requests — no streaming, and no
    /// parallel download either. Worth saying out loud in the UI.
    pub seekable: bool,
    pub files: Vec<ResolvedFileDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFile {
    pub name: String,
    pub size: u64,
    pub url: String,
    /// A digest the source published, if it has one.
    pub sha256: Option<String>,
}

/// Build an engine link out of plain HTTP sources — GitHub release assets, or an
/// old-format LAN manifest. Those backends are resolved by the frontend (they
/// need a GitHub token and speak their own JSON), but the link they turn into
/// belongs to the engine, so the wire format never gets hand-rolled in JS.
#[tauri::command]
pub fn engine_http_link(name: String, files: Vec<HttpFile>) -> Result<String, String> {
    let first = files.first().ok_or_else(|| "no files to link".to_string())?;
    if files.len() == 1 {
        let mut link = prev_core::ShareLink::file("http", &first.url, &first.name, first.size);
        link.sha256 = first.sha256.clone();
        return Ok(link.encode());
    }
    // A folder link carries its file list, so resolving it costs no network at all.
    // `url` is never fetched in that case, but a link with an empty one is invalid.
    let entries = files
        .iter()
        .map(|f| prev_core::ShareFile {
            name: f.name.clone(),
            size: f.size,
            url: f.url.clone(),
            sha256: f.sha256.clone(),
            hash_url: None,
        })
        .collect();
    Ok(prev_core::ShareLink::folder("http", &first.url, &name, entries).encode())
}

/// Turn pasted text — a `prev://` link or a bare `http(s)://` URL — into
/// something the UI can show before committing to a transfer.
#[tauri::command]
pub async fn engine_resolve(
    state: State<'_, EngineState>,
    link: String,
) -> Result<ResolvedDto, String> {
    let share = state.resolve(&link).await?;
    Ok(ResolvedDto {
        link,
        name: share.name.clone(),
        kind: share.kind.to_string(),
        total_size: share.total_size,
        transport: share.transport.clone(),
        seekable: share.seekable,
        files: share
            .files
            .iter()
            .enumerate()
            .map(|(index, f)| ResolvedFileDto { index, name: f.name.clone(), size: f.size })
            .collect(),
    })
}

/// Open a stream and return a plain `http://127.0.0.1` URL — hand it straight to
/// mpv's `loadfile`. Nothing is written to disk unless `engine_save_stream` is
/// called later.
#[tauri::command]
pub async fn engine_watch(
    state: State<'_, EngineState>,
    link: String,
    index: Option<usize>,
) -> Result<WatchHandle, String> {
    let file = state.file_link(&link, index).await?;
    state.engine.watch(&file).await.map_err(|e| e.to_string())
}

/// Frees the buffer and tears the session down — which waits on the playback
/// threads, so it does not belong on the UI thread.
#[tauri::command]
pub async fn engine_stop_watch(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    let engine = state.engine.clone();
    blocking(move || {
        engine.stop_watch(&id);
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// Transfer id — the key for progress events, pause, resume and cancel.
    pub id: String,
    pub name: String,
    pub size: u64,
    /// Where the finished file will land.
    pub dest: String,
}

/// Queue a download. `indices` picks entries out of a folder share; omit it to
/// take everything the share offers.
#[tauri::command]
pub async fn engine_download(
    state: State<'_, EngineState>,
    link: String,
    indices: Option<Vec<usize>>,
    dest_dir: Option<String>,
) -> Result<Vec<Started>, String> {
    let share = state.resolve(&link).await?;
    let dir = dest_dir.map(PathBuf::from);
    let wanted: Vec<usize> = indices.unwrap_or_else(|| (0..share.files.len()).collect());

    let mut started = Vec::with_capacity(wanted.len());
    for i in wanted {
        let file = share
            .files
            .get(i)
            .ok_or_else(|| format!("this share has no file #{i}"))?;
        let id = state
            .engine
            .download(&file.link, dir.clone())
            .await
            .map_err(|e| e.to_string())?;
        let dest = state
            .engine
            .transfer(&id)
            .ok()
            .flatten()
            .map(|r| r.dest)
            .unwrap_or_default();
        started.push(Started { id, name: file.name.clone(), size: file.size, dest });
    }
    Ok(started)
}

#[tauri::command]
pub async fn engine_pause(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    let engine = state.engine.clone();
    blocking(move || engine.pause(&id).map_err(|e| e.to_string())).await
}

/// Reloads the chunk map from SQLite and relaunches the workers.
#[tauri::command]
pub async fn engine_resume(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    let engine = state.engine.clone();
    blocking(move || engine.resume(&id).map_err(|e| e.to_string())).await
}

/// Deletes the `.partial` and the record when the job isn't running.
#[tauri::command]
pub async fn engine_cancel(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    let engine = state.engine.clone();
    blocking(move || engine.cancel(&id).map_err(|e| e.to_string())).await
}

/// Every transfer the engine knows about, finished or not. Called at startup so
/// downloads interrupted by a quit come back as resumable rows instead of
/// vanishing — the chunk map on disk is what makes that honest.
#[tauri::command]
pub async fn engine_transfers(state: State<'_, EngineState>) -> Result<serde_json::Value, String> {
    let engine = state.engine.clone();
    blocking(move || {
        let records = engine.transfers().map_err(|e| e.to_string())?;
        serde_json::to_value(records).map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------------------
// Keeping a copy of what you're watching
// ---------------------------------------------------------------------------

/// Start writing the stream to disk without interrupting playback. Bytes already
/// buffered are written immediately, so saving a film you're an hour into does
/// not re-fetch that hour. Returns the transfer id the save is tracked under.
///
/// That opening flush is the single most blocking call in this file — it can put
/// the entire resident buffer (256 MB by default) on disk before it returns.
#[tauri::command]
pub async fn engine_save_stream(
    state: State<'_, EngineState>,
    id: String,
    dest_dir: Option<String>,
) -> Result<String, String> {
    let engine = state.engine.clone();
    blocking(move || {
        engine
            .save_stream(&id, dest_dir.map(PathBuf::from))
            .map_err(|e| e.to_string())
    })
    .await
}

/// Stop saving. If playback never reached the whole file the result is
/// `resumable` — `engine_finish_save` then fetches only the gaps.
#[tauri::command]
pub async fn engine_stop_saving(
    state: State<'_, EngineState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let engine = state.engine.clone();
    blocking(move || {
        let outcome = engine.stop_saving(&id).map_err(|e| e.to_string())?;
        serde_json::to_value(outcome).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn engine_finish_save(
    state: State<'_, EngineState>,
    transfer_id: String,
) -> Result<(), String> {
    let engine = state.engine.clone();
    blocking(move || engine.finish_save(&transfer_id).map_err(|e| e.to_string())).await
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/// Where downloads land by default (…/Downloads/PREV Player), created if needed.
#[tauri::command]
pub async fn engine_download_dir(state: State<'_, EngineState>) -> Result<String, String> {
    let dir = state.engine.config().download_dir.clone();
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
pub async fn engine_tuning(app: AppHandle) -> Result<Tuning, String> {
    blocking(move || Ok(read_tuning(&app))).await
}

#[tauri::command]
pub async fn engine_set_tuning(app: AppHandle, tuning: Tuning) -> Result<(), String> {
    blocking(move || {
        let path = tuning_path(&app).ok_or_else(|| "no app data directory".to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&tuning).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    })
    .await
}

/// Stop serving shares and playback. In-flight downloads keep their `.partial`
/// files and resume next launch.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        state.engine.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// The setup hook runs outside any runtime, but `Engine::start` calls
    /// `Handle::current()` — and needs the multi-threaded flavour, because the
    /// playback endpoint blocks its own OS threads on async reads. `block_on` is
    /// what bridges the two, so this pins both halves of that claim.
    #[test]
    fn the_engine_starts_on_tauris_runtime() {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "a test thread is not in a runtime — same as Tauri's setup hook"
        );

        let flavour = tauri::async_runtime::block_on(async {
            tokio::runtime::Handle::current().runtime_flavor()
        });
        assert_eq!(flavour, tokio::runtime::RuntimeFlavor::MultiThread);

        let dir = std::env::temp_dir().join(format!("prev-player-init-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = EngineConfig {
            state_db: dir.join("transfers.db"),
            download_dir: dir.clone(),
            share_on_lan: false,
            ..Default::default()
        };
        let engine = tauri::async_runtime::block_on(async move {
            Engine::start(config, prev_core::null_sink())
        })
        .expect("the engine must start from inside Tauri's runtime");

        assert!(engine.transfers().unwrap().is_empty());
        engine.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real thing, end to end: share an actual large HDR MKV, open a watch
    /// session, and point the bundled mpv at the resulting URL. Reported symptom
    /// is that playback never leaves 0:00 while the engine reports thousands of
    /// chunk fetches — so this asserts mpv reaches a real timestamp, and prints
    /// what the engine did to get there.
    ///
    /// Ignored by default: it needs a specific file. Run with
    /// `cargo test --lib big_mkv -- --ignored --nocapture`.
    #[ignore]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn big_mkv_plays_through_mpv_over_the_stream_url() {
        let source = std::path::PathBuf::from(
            std::env::var("PREV_TEST_FILE").unwrap_or_else(|_| r"D:\movies\.mkv".into()),
        );
        if !source.exists() {
            eprintln!("skipping: {} not present", source.display());
            return;
        }

        let dir = std::env::temp_dir().join(format!("prev-bigmkv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let engine = Engine::start(
            EngineConfig {
                state_db: dir.join("state.db"),
                download_dir: dir.clone(),
                share_on_lan: false,
                ..Default::default()
            },
            prev_core::null_sink(),
        )
        .unwrap();
        let state = EngineState { engine, resolved: Mutex::new(HashMap::new()) };

        let link = state.engine.share_file(&source).unwrap().encode();
        let watch = state
            .engine
            .watch(&state.file_link(&link, None).await.unwrap())
            .await
            .unwrap();
        println!("streaming {} ({} bytes) at {}", watch.name, watch.size, watch.url);

        let mpv = std::path::Path::new("resources/mpv/mpv.exe");
        assert!(mpv.exists(), "bundled mpv missing at {}", mpv.display());

        let out = tokio::task::spawn_blocking({
            let url = watch.url.clone();
            let mpv = mpv.to_path_buf();
            move || {
                std::process::Command::new(mpv)
                    .args([
                        &url,
                        "--vo=null",
                        "--ao=null",
                        "--no-config",
                        "--hwdec=no", // the renderer is not what's on trial here
                        // The server answers an open-ended range with a bounded
                        // slice; ffmpeg must be willing to ask again rather than
                        // treat the short body as a broken connection.
                        "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5",
                        "--length=10",
                        "--msg-level=all=status",
                    ])
                    .output()
                    .expect("failed to run mpv")
            }
        })
        .await
        .unwrap();

        let log = String::from_utf8_lossy(&out.stderr).to_string()
            + &String::from_utf8_lossy(&out.stdout);
        let reached = log
            .lines()
            .filter_map(|l| l.split("AV: ").nth(1))
            .filter_map(|l| l.split_whitespace().next())
            .last()
            .unwrap_or("never")
            .to_string();

        let s = state.engine.stream(&watch.id).map(|s| s.stats());
        if let Some(s) = &s {
            println!(
                "engine: {} fetches, {} MB cached, {} MB ahead",
                s.fetches,
                s.cached_bytes / (1024 * 1024),
                s.buffered_ahead / (1024 * 1024)
            );
        }
        println!("mpv reached {reached}");
        for l in log.lines().filter(|l| !l.contains("AV:")).take(25) {
            println!("mpv| {l}");
        }

        state.engine.shutdown();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            reached != "never" && reached != "00:00:00",
            "mpv never advanced past 0:00 over the stream URL (reached {reached})"
        );
    }

    /// A 30 GB MKV downloads but won't stream. An MKV keeps its cues at EOF, so
    /// a player reads the header, seeks to the very end, and seeks back — and it
    /// abandons each response as it goes. That is a different shape of load from
    /// "read it start to finish", and it is the shape a big file makes visible.
    ///
    /// The file here is sparse (instant to create, costs no disk) but big enough
    /// to take the >8 GB branch of `ChunkPlan::auto`, so the link's 16 MB grid and
    /// the stream's own 2 MB grid are both in play.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_multi_gigabyte_file_survives_a_players_seek_pattern() -> Result<(), String> {
        const GB: u64 = 1024 * 1024 * 1024;
        let total = 9 * GB;

        let dir = std::env::temp_dir().join(format!("prev-bigfile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("film.mkv");
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut f = std::fs::File::create(&big).unwrap();
            // Without the sparse flag NTFS zero-fills all 9 GB on `set_len`, which
            // costs far more than the thing being measured.
            let _ = std::process::Command::new("fsutil")
                .args(["sparse", "setflag", &big.to_string_lossy()])
                .output();
            f.write_all(b"HEADER").unwrap();
            f.set_len(total).unwrap();
            f.seek(SeekFrom::Start(total - 4)).unwrap();
            f.write_all(b"CUES").unwrap();
            f.sync_all().unwrap();
        }

        let engine = Engine::start(
            EngineConfig {
                state_db: dir.join("state.db"),
                download_dir: dir.clone(),
                share_on_lan: false,
                ..Default::default()
            },
            prev_core::null_sink(),
        )
        .unwrap();
        let state = EngineState { engine, resolved: Mutex::new(HashMap::new()) };

        let link = state.engine.share_file(&big).unwrap().encode();
        let resolved = state.resolve(&link).await?;
        assert_eq!(resolved.total_size, total, "the share is sized in u64, not truncated");
        assert!(resolved.seekable);

        let watch = state
            .engine
            .watch(&state.file_link(&link, None).await.unwrap())
            .await
            .unwrap();
        assert_eq!(watch.size, total);

        let client = reqwest::Client::new();
        let range = |a: u64, b: u64| {
            let (c, url) = (client.clone(), watch.url.clone());
            async move {
                c.get(&url)
                    .header("Range", format!("bytes={a}-{b}"))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap()
                    .to_vec()
            }
        };
        // Every step gets a generous budget; the failure being chased is a hang,
        // so a timeout has to fail the test rather than wedge the suite.
        let budget = Duration::from_secs(60);

        // The open-ended request a player opens with. Everything it later does
        // depends on learning the total from this one response: without it
        // ffmpeg's avio_size() reports ENOSYS and refuses to seek at all, which
        // for an MKV (cues at EOF) means it cannot play the file.
        {
            let probe = client
                .get(&watch.url)
                .header("Range", "bytes=0-")
                .send()
                .await
                .unwrap();
            let h = |n: &str| probe.headers().get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            println!("probe status={} range={:?} len={:?}", probe.status(), h("content-range"), h("content-length"));
            assert_eq!(probe.status().as_u16(), 206, "an open-ended range is a partial response");
            assert_eq!(
                h("content-range"),
                format!("bytes 0-{}/{}", 8 * 1024 * 1024 - 1, total),
                "the total must be present, and the served slice bounded"
            );
            assert_eq!(h("content-length"), (8 * 1024 * 1024).to_string());
            assert_eq!(h("accept-ranges"), "bytes");
        }

        let t = std::time::Instant::now();
        let head = tokio::time::timeout(budget, range(0, 5))
            .await
            .expect("reading the header hung");
        println!("STEP header: {:?}", t.elapsed());
        assert_eq!(&head, b"HEADER", "header served from the front of the file");

        // The seek an MKV forces: 9 GB in, nowhere near anything prefetched.
        let t = std::time::Instant::now();
        let cues = tokio::time::timeout(budget, range(total - 4, total - 1))
            .await
            .expect("seeking to the cues at EOF hung — a demand read past the prefetch window");
        println!("STEP cues-at-eof: {:?}", t.elapsed());
        assert_eq!(&cues, b"CUES", "the tail is fetched on demand, not waited for");

        // Now abandon several full-length responses, which is what a player does
        // every time it seeks: open `bytes=N-`, read a little, drop the rest. Each
        // one must hand its serving thread back, or the pool starves and the next
        // request — the one that matters — never gets answered.
        for i in 0..8u64 {
            let t = std::time::Instant::now();
            let mut resp = client
                .get(&watch.url)
                .header("Range", format!("bytes={}-", i * GB))
                .send()
                .await
                .unwrap();
            let _ = tokio::time::timeout(budget, resp.chunk())
                .await
                .expect("an abandoned response stalled");
            drop(resp);
            println!("STEP abandon #{i}: {:?}", t.elapsed());
        }

        let t = std::time::Instant::now();
        let again = tokio::time::timeout(budget, range(0, 5))
            .await
            .expect("the stream server stopped answering after abandoned responses");
        println!("STEP header-again: {:?}", t.elapsed());
        assert_eq!(&again, b"HEADER", "still serving after eight abandoned reads");

        state.engine.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
        Ok::<(), String>(())
    }

    /// The reported failure: share one video, forget to stop it, share a second,
    /// then open the second — and get the first. Shares are additive on purpose,
    /// so this pins that a live share never bleeds into the next one, through the
    /// resolve cache and the watch sessions both.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_second_share_does_not_serve_the_first() {
        let dir = std::env::temp_dir().join(format!("prev-two-shares-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let a = dir.join("first.mkv");
        let b = dir.join("second.mkv");
        std::fs::write(&a, vec![0xAAu8; 1_500_000]).unwrap();
        std::fs::write(&b, vec![0xBBu8; 900_000]).unwrap();

        let engine = Engine::start(
            EngineConfig {
                state_db: dir.join("state.db"),
                download_dir: dir.clone(),
                share_on_lan: false,
                ..Default::default()
            },
            prev_core::null_sink(),
        )
        .unwrap();
        let state = EngineState { engine, resolved: Mutex::new(HashMap::new()) };

        let fetch = |url: String| async move {
            reqwest::get(&url).await.unwrap().bytes().await.unwrap().to_vec()
        };

        // Share and watch the first, exactly as the app does.
        let link_a = state.engine.share_file(&a).unwrap().encode();
        let watch_a = state.engine.watch(&state.file_link(&link_a, None).await.unwrap()).await.unwrap();
        let got_a = fetch(watch_a.url.clone()).await;
        assert_eq!(got_a.len(), 1_500_000);
        assert!(got_a.iter().all(|&x| x == 0xAA), "the first share serves the first file");

        // Now share a second WITHOUT stopping the first — the reported situation.
        let link_b = state.engine.share_file(&b).unwrap().encode();
        assert_ne!(link_a, link_b, "each share gets its own id, so its own link");
        assert_eq!(state.engine.active_shares().len(), 2, "both are live");

        let resolved_b = state.resolve(&link_b).await.unwrap();
        assert_eq!(resolved_b.name, "second.mkv");
        assert_eq!(resolved_b.total_size, 900_000, "sized as the second file, not the first");

        let watch_b = state.engine.watch(&state.file_link(&link_b, None).await.unwrap()).await.unwrap();
        assert_ne!(watch_a.url, watch_b.url, "a second session, not a reused one");
        let got_b = fetch(watch_b.url.clone()).await;
        assert_eq!(got_b.len(), 900_000, "got the second file's length");
        assert!(got_b.iter().all(|&x| x == 0xBB), "and the second file's bytes");

        // The first is still serving correctly too — nothing was clobbered.
        let again_a = fetch(watch_a.url.clone()).await;
        assert!(again_a.iter().all(|&x| x == 0xAA) && again_a.len() == 1_500_000);

        state.engine.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The frontend gets a revocation id, and the only place it can come from is
    /// the link the share server just minted.
    #[test]
    fn a_share_id_is_recoverable_from_the_url_the_link_carries() {
        assert_eq!(share_id_of("http://192.168.1.5:7421/s/ab12"), "ab12");
        assert_eq!(share_id_of("http://192.168.1.5:7421/f/cd34/"), "cd34");
    }

    /// GitHub assets arrive as a plain list and have to come back out as one
    /// link the engine can resolve without touching the network again.
    #[test]
    fn github_assets_become_a_folder_link_that_resolves_offline() {
        let files = vec![
            HttpFile { name: "E01.mkv".into(), size: 100, url: "https://x/1".into(), sha256: None },
            HttpFile { name: "E02.mkv".into(), size: 250, url: "https://x/2".into(), sha256: None },
        ];
        let encoded = engine_http_link("Season 1".into(), files).unwrap();

        let decoded = prev_core::ShareLink::decode(&encoded).unwrap();
        assert_eq!(decoded.kind, prev_core::ShareKind::Folder);
        assert_eq!(decoded.name, "Season 1");
        assert_eq!(decoded.size, 350, "a folder link sums its parts");
        assert_eq!(decoded.files.unwrap().len(), 2);

        let one = vec![HttpFile {
            name: "Movie.mkv".into(),
            size: 42,
            url: "https://x/m".into(),
            sha256: Some("deadbeef".into()),
        }];
        let single = prev_core::ShareLink::decode(&engine_http_link("Movie".into(), one).unwrap()).unwrap();
        assert_eq!(single.kind, prev_core::ShareKind::File);
        assert_eq!(single.sha256.as_deref(), Some("deadbeef"), "the digest must survive");
    }
}
