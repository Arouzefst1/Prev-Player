//! Transports: the only part of the engine that knows *where* bytes come from.
//!
//! Everything above this layer — chunk management, downloads, streaming —
//! speaks only [`Transport`]. Adding internet P2P, a torrent swarm or a cloud
//! plugin later means implementing this one trait; nothing else changes.
//!
//! The contract is deliberately tiny and random-access:
//!
//! * [`Transport::stat`] — how big is it, what's it called, can it seek?
//! * [`Transport::read_range`] — give me exactly these bytes.
//!
//! Random access is what makes parallel downloads, resume and seeking during a
//! stream all fall out of the same primitive.

pub mod file;
pub mod http;
pub mod manifest;
pub mod retry;

pub use file::FileTransport;
pub use http::HttpTransport;
pub use manifest::{fetch_manifest, FolderManifest, ManifestItem};
pub use retry::{read_range_retrying, RetryPolicy};

use async_trait::async_trait;
use prev_core::{EngineError, Result, ShareLink};
use std::sync::Arc;

/// What a transport can tell us about a source before we transfer anything.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceMeta {
    pub size: u64,
    pub name: String,
    pub content_type: Option<String>,
    /// False means the source can only be read start-to-finish. The chunk
    /// engine refuses to run parallel/resumable transfers against it.
    pub supports_ranges: bool,
}

#[async_trait]
pub trait Transport: Send + Sync + 'static {
    /// Short id used in share links and diagnostics: `lan`, `http`, `file`, ...
    fn scheme(&self) -> &'static str;

    /// A stable, human-readable description of the endpoint (for logs/UI).
    fn describe(&self) -> String;

    async fn stat(&self) -> Result<SourceMeta>;

    /// Read exactly `len` bytes starting at `offset` into `out`.
    ///
    /// `out` is cleared and refilled by appending, so a pooled buffer keeps its
    /// allocation. A short read is an error — partial chunks never reach the
    /// caller, which is what lets the layers above treat a returned chunk as
    /// unconditionally complete.
    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()>;
}

/// Build a transport for a decoded share link.
///
/// The only place that maps a link's transport id onto an implementation, so a
/// new transport becomes reachable by adding one arm here.
pub fn resolve(link: &ShareLink) -> Result<Arc<dyn Transport>> {
    resolve_url(&link.transport, &link.url)
}

pub fn resolve_url(scheme: &str, url: &str) -> Result<Arc<dyn Transport>> {
    match scheme {
        // `lan` and `http` are both plain HTTP with range support; they differ
        // only in reachability and lifetime, which the link already records.
        "lan" | "http" | "https" | "github" => Ok(Arc::new(HttpTransport::new(url)?)),
        "file" => Ok(Arc::new(FileTransport::new(url))),
        other => Err(EngineError::Transport(format!(
            "no transport registered for '{other}'"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_schemes_and_rejects_unknown() {
        let lan = ShareLink::file("lan", "http://127.0.0.1:1/s/a", "v.mkv", 10);
        assert_eq!(resolve(&lan).unwrap().scheme(), "http");

        let mut future = lan.clone();
        future.transport = "torrent".into();
        assert!(resolve(&future).is_err());
    }
}
