//! The façade.
//!
//! A host application (the Tauri app, the CLI, a test) creates one [`Engine`]
//! and talks only to it. Everything below — chunk plans, transports, worker
//! pools, SQLite — stays private, so the app's command layer is a thin
//! translation of these methods into whatever the UI speaks.
//!
//! ```no_run
//! # async fn demo() -> prev_core::Result<()> {
//! use prev_engine::{Engine, EngineConfig};
//! use std::sync::Arc;
//!
//! let engine = Engine::start(EngineConfig::default(), Arc::new(|event| {
//!     // app.emit("prev-engine", event) in Tauri; println! in the CLI.
//!     let _ = event;
//! }))?;
//!
//! // Sender
//! let link = engine.share_file("D:/Movies/Movie.mkv")?;
//! println!("{}", link.encode());
//!
//! // Receiver
//! let resolved = engine.resolve(&link.encode()).await?;
//! let watch = engine.watch(&resolved.link).await?;   // play watch.url in mpv
//! let id = engine.download(&resolved.link, None).await?;
//! # Ok(()) }
//! ```

mod resolve;

pub use resolve::{ResolvedFile, ResolvedShare};

use prev_core::{
    EngineError, EventSink, Result, ShareLink, TransferState,
};
use prev_download::state::StateStore;
use prev_download::{DownloadConfig, DownloadEngine, DownloadRecord};
use prev_share::{ActiveShare, ShareServer};
use prev_stream::session::SaveOutcome;
use prev_stream::{StreamConfig, StreamServer, StreamSession};
use prev_transport::resolve_url;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// Where resume state lives. Defaults to a temp path; a real app should
    /// point this at its app-data directory.
    pub state_db: PathBuf,
    /// Default destination for downloads and saved streams.
    pub download_dir: PathBuf,
    pub download: DownloadConfig,
    pub stream: StreamConfig,
    /// Bind the share server to every interface (the point of LAN sharing).
    /// Set false to keep shares reachable only from this machine.
    pub share_on_lan: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        let base = default_download_dir();
        Self {
            state_db: base.join(".prev-engine").join("state.db"),
            download_dir: base,
            download: DownloadConfig::default(),
            stream: StreamConfig::default(),
            share_on_lan: true,
        }
    }
}

/// `~/Downloads/PREV Player`, falling back to the temp directory.
pub fn default_download_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let downloads = home.join("Downloads");
    let base = if downloads.exists() { downloads } else { home };
    base.join("PREV Player")
}

/// A stream ready for the player.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHandle {
    pub id: String,
    /// Hand this straight to mpv — it is an ordinary seekable HTTP URL.
    pub url: String,
    pub name: String,
    pub size: u64,
}

pub struct Engine {
    store: Arc<StateStore>,
    downloads: Arc<DownloadEngine>,
    streams: StreamServer,
    share: Mutex<Option<ShareServer>>,
    config: EngineConfig,
    sink: EventSink,
    session_counter: Mutex<u64>,
}

impl Engine {
    /// Start the engine. Must be called from inside a **multi-threaded** tokio
    /// runtime: the playback endpoint blocks its own OS threads on async reads,
    /// which a current-thread runtime cannot drive.
    pub fn start(config: EngineConfig, sink: EventSink) -> Result<Arc<Self>> {
        let store = Arc::new(StateStore::open(&config.state_db)?);
        std::fs::create_dir_all(&config.download_dir)?;
        let downloads = DownloadEngine::new(store.clone(), sink.clone(), config.download.clone());
        let streams = StreamServer::start(tokio::runtime::Handle::current())?;
        Ok(Arc::new(Self {
            store,
            downloads,
            streams,
            share: Mutex::new(None),
            config,
            sink,
            session_counter: Mutex::new(0),
        }))
    }

    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    pub fn downloads(&self) -> &Arc<DownloadEngine> {
        &self.downloads
    }

    pub fn store(&self) -> &Arc<StateStore> {
        &self.store
    }

    // -- Sending ------------------------------------------------------------

    /// The share server is started on first use, so an app that never shares
    /// never opens a listening port.
    fn share_server(&self) -> Result<ShareServer> {
        let mut guard = self.share.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let server = if self.config.share_on_lan {
            ShareServer::start()?
        } else {
            ShareServer::start_local()?
        };
        *guard = Some(server.clone());
        Ok(server)
    }

    pub fn share_file(&self, path: impl AsRef<Path>) -> Result<ShareLink> {
        self.share_server()?.share_file(path)
    }

    pub fn share_folder(&self, paths: &[PathBuf], folder_name: &str) -> Result<ShareLink> {
        self.share_server()?.share_folder(paths, folder_name)
    }

    pub fn stop_share(&self, id: &str) -> bool {
        self.share
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.stop(id))
            .unwrap_or(false)
    }

    pub fn stop_all_shares(&self) {
        if let Some(s) = self.share.lock().unwrap().as_ref() {
            s.stop_all();
        }
    }

    pub fn active_shares(&self) -> Vec<ActiveShare> {
        self.share
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.active())
            .unwrap_or_default()
    }

    // -- Receiving ----------------------------------------------------------

    /// Turn pasted text into something the UI can show: name, size, and — for a
    /// folder share — the file list, each entry usable on its own.
    pub async fn resolve(&self, input: &str) -> Result<ResolvedShare> {
        resolve::resolve(input).await
    }

    pub async fn download(&self, link: &ShareLink, dest_dir: Option<PathBuf>) -> Result<String> {
        let dir = dest_dir.unwrap_or_else(|| self.config.download_dir.clone());
        self.downloads.start(link, dir).await
    }

    /// Queue every file of a resolved folder share.
    pub async fn download_all(
        &self,
        resolved: &ResolvedShare,
        dest_dir: Option<PathBuf>,
    ) -> Result<Vec<String>> {
        let dir = dest_dir.unwrap_or_else(|| self.config.download_dir.clone());
        let mut ids = Vec::new();
        for file in &resolved.files {
            ids.push(self.downloads.start(&file.link, dir.clone()).await?);
        }
        Ok(ids)
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        self.downloads.pause(id)
    }

    pub fn resume(&self, id: &str) -> Result<()> {
        self.downloads.resume(id)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        self.downloads.cancel(id)
    }

    pub fn transfers(&self) -> Result<Vec<DownloadRecord>> {
        self.downloads.list()
    }

    pub fn transfer(&self, id: &str) -> Result<Option<DownloadRecord>> {
        self.downloads.get(id)
    }

    pub async fn wait(&self, id: &str) -> Result<TransferState> {
        self.downloads.wait(id).await
    }

    // -- Watching -----------------------------------------------------------

    /// Open a stream and return a URL the player can open immediately. Nothing
    /// is written to disk unless [`save_stream`](Self::save_stream) is called.
    pub async fn watch(&self, link: &ShareLink) -> Result<WatchHandle> {
        let transport = resolve_url(&link.transport, &link.url)?;
        let meta = transport.stat().await?;
        if !meta.supports_ranges {
            return Err(EngineError::NoRangeSupport);
        }

        // Fill in anything the link didn't carry (a bare http:// URL, say).
        let mut link = link.clone();
        if link.size == 0 {
            link.size = meta.size;
        }
        if link.name.is_empty() {
            link.name = meta.name.clone();
        }
        if link.chunk_size == 0 {
            link.chunk_size = prev_core::ChunkPlan::auto(link.size).chunk_size;
        }

        let id = {
            let mut c = self.session_counter.lock().unwrap();
            *c += 1;
            format!("stream-{}", *c)
        };
        let session = StreamSession::new(
            id.clone(),
            &link,
            transport,
            self.config.stream.clone(),
            self.sink.clone(),
        )?;
        session.spawn_background();
        let url = self.streams.publish(session);

        Ok(WatchHandle { id, url, name: link.name, size: link.size })
    }

    pub fn stream(&self, id: &str) -> Option<Arc<StreamSession>> {
        self.streams.get(id)
    }

    /// Stop playback and free the buffer immediately.
    pub fn stop_watch(&self, id: &str) {
        self.streams.remove(id);
    }

    pub fn active_streams(&self) -> Vec<String> {
        self.streams.active()
    }

    /// Start writing the stream to disk without interrupting playback.
    /// Returns the transfer id the save is tracked under.
    pub fn save_stream(&self, id: &str, dest_dir: Option<PathBuf>) -> Result<String> {
        let session = self
            .streams
            .get(id)
            .ok_or_else(|| EngineError::Other(format!("no active stream {id}")))?;
        let dir = dest_dir.unwrap_or_else(|| self.config.download_dir.clone());
        session.start_saving(dir, self.store.clone())
    }

    /// Stop saving. If viewing did not cover the whole file the result is a
    /// resumable transfer; [`finish_save`](Self::finish_save) completes it.
    pub fn stop_saving(&self, id: &str) -> Result<SaveOutcome> {
        let session = self
            .streams
            .get(id)
            .ok_or_else(|| EngineError::Other(format!("no active stream {id}")))?;
        session.stop_saving()
    }

    /// Fetch only the parts of a saved stream that playback never reached.
    pub fn finish_save(&self, transfer_id: &str) -> Result<()> {
        self.downloads.resume(transfer_id)
    }

    // -- Lifecycle ----------------------------------------------------------

    /// Stop serving shares and playback. In-flight downloads keep their
    /// `.partial` files and resume next launch.
    pub fn shutdown(&self) {
        self.streams.shutdown();
        if let Some(s) = self.share.lock().unwrap().take() {
            s.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_download_directory_is_absolute_and_named() {
        let d = default_download_dir();
        assert!(d.is_absolute(), "{d:?}");
        assert!(d.ends_with("PREV Player"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn starting_the_engine_opens_no_listening_port_until_asked_to_share() {
        let dir = std::env::temp_dir().join(format!("prev-engine-lazy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = EngineConfig {
            state_db: dir.join("state.db"),
            download_dir: dir.clone(),
            share_on_lan: false,
            ..Default::default()
        };
        let engine = Engine::start(config, prev_core::null_sink()).unwrap();
        assert!(engine.active_shares().is_empty());
        assert!(engine.share.lock().unwrap().is_none(), "no share server yet");

        let file = dir.join("clip.mkv");
        std::fs::write(&file, b"hello").unwrap();
        let link = engine.share_file(&file).unwrap();
        assert_eq!(link.name, "clip.mkv");
        assert!(engine.share.lock().unwrap().is_some(), "started on demand");
        assert_eq!(engine.active_shares().len(), 1);

        engine.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
