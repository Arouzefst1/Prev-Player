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
use prev_core::{url_host, EngineError, Result, ShareLink};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

/// The HTTP client every transfer, manifest and digest request is made with.
///
/// A sender on this network is dialled directly, never through a proxy: a
/// system or environment proxy (office settings, a VPN app's local proxy) has
/// no route to another device on the Wi-Fi, so going through one is how a
/// receiver on the same network still couldn't connect.
///
/// TCP keepalive is what notices a sender that vanished mid-transfer — the
/// laptop slept, or left the Wi-Fi — and turns a read that would otherwise wait
/// forever into an error the chunk retries. A sender that is merely busy still
/// answers the probes, so a request queued behind others never trips it, which
/// is why this isn't a read timeout.
///
/// A LAN sender also gets one connection per request, closed after the
/// response. The share server (tiny_http 0.12) gives every connection a pooled
/// thread for as long as it stays open, and its pool can drop the wake-up for a
/// connection that arrives in the same instant as another. That connection then
/// isn't read until some other one closes — and kept-alive idle connections
/// stay open 90 s, so a chunk request sat unanswered for one to three minutes.
/// With every connection closing after its response the pool keeps turning
/// over, and a queued connection is picked up at once. On a LAN a fresh TCP
/// handshake per multi-megabyte chunk costs nothing measurable.
pub fn http_client(url: &str) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent("PREV-Player/engine")
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Duration::from_secs(15))
        .tcp_keepalive_interval(Duration::from_secs(5))
        .tcp_keepalive_retries(3);
    if is_local_url(url) {
        builder = builder.no_proxy().pool_max_idle_per_host(0);
    }
    builder.build().map_err(EngineError::transport)
}

/// Does this URL point at this machine or the local network — somewhere no
/// proxy can reach on our behalf?
pub fn is_local_url(url: &str) -> bool {
    let Some(host) = url_host(url) else { return false };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            ip.is_private() || ip.is_loopback() || ip.is_link_local()
                || (a == 100 && (64..128).contains(&b)) // CGNAT / Tailscale
        }
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

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
    fn lan_and_loopback_addresses_skip_the_proxy_and_the_internet_does_not() {
        for local in [
            "http://192.168.1.23:4000/s/x",
            "http://10.0.0.7:1/",
            "http://172.20.1.1/",
            "http://169.254.3.4/",
            "http://100.101.2.3/",
            "http://127.0.0.1:9/",
            "http://localhost:3001/",
            "http://[fe80::1]:80/",
        ] {
            assert!(is_local_url(local), "{local}");
        }
        for remote in ["https://github.com/a/b", "http://8.8.8.8/", "https://objects.githubusercontent.com/x"] {
            assert!(!is_local_url(remote), "{remote}");
        }
    }

    #[test]
    fn resolves_known_schemes_and_rejects_unknown() {
        let lan = ShareLink::file("lan", "http://127.0.0.1:1/s/a", "v.mkv", 10);
        assert_eq!(resolve(&lan).unwrap().scheme(), "http");

        let mut future = lan.clone();
        future.transport = "torrent".into();
        assert!(resolve(&future).is_err());
    }
}
