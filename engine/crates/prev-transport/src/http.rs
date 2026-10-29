//! HTTP transport — backs LAN shares, GitHub release assets and any plain URL.
//!
//! One implementation covers all three because the only thing the engine needs
//! from a source is byte-range reads, and that is exactly what HTTP/1.1 ranges
//! give us.

use crate::{http_client, SourceMeta, Transport};
use async_trait::async_trait;
use prev_core::{EngineError, Result};
use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::{Client, StatusCode};
use std::time::Duration;

pub struct HttpTransport {
    client: Client,
    url: String,
}

impl HttpTransport {
    pub fn new(url: &str) -> Result<Self> {
        // No total-request timeout on purpose: a single 16 MB chunk over a slow
        // link is legitimately slow; a dead sender is caught by keepalive.
        Ok(Self { client: http_client(url)?, url: url.to_string() })
    }

    /// Reuse an existing client (connection pool, proxy config, auth headers).
    pub fn with_client(client: Client, url: &str) -> Self {
        Self { client, url: url.to_string() }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Last path segment, percent-decoded. The scheme and authority are dropped
    /// first so `http://host:1/` yields a placeholder rather than the host name.
    fn name_from_url(&self) -> String {
        let no_query = self.url.split('?').next().unwrap_or(&self.url);
        let after_scheme = no_query.split_once("://").map(|(_, r)| r).unwrap_or(no_query);
        let path = after_scheme.split_once('/').map(|(_, p)| p).unwrap_or("");
        let last = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("download");
        percent_decode(last)
    }
}

/// What a receiver is told when the sender no longer serves the file. A LAN
/// share answers 404 once it is stopped; a GitHub share once it is deleted.
pub const SHARE_GONE: &str =
    "This share isn't available any more — the sender stopped it, closed PREV Player, or removed it. Ask them to share it again.";

/// A request that never got an HTTP answer, worded for a person. reqwest's own
/// message ("error sending request for url") hides the reason, which lives in
/// the error's source chain.
fn request_failed(e: reqwest::Error) -> EngineError {
    let what = if e.is_connect() {
        "couldn't connect to the sender"
    } else if e.is_timeout() {
        "the sender stopped responding"
    } else {
        "the connection to the sender failed"
    };
    let mut cause = String::new();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        cause = s.to_string();
        src = s.source();
    }
    let at = e.url().and_then(|u| u.host_str().map(|h| format!(" at {h}"))).unwrap_or_default();
    if cause.is_empty() {
        EngineError::Transport(format!("{what}{at}"))
    } else {
        EngineError::Transport(format!("{what}{at} ({cause})"))
    }
}

/// What one address said when asked for a share.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// The share is served here.
    Serves,
    /// Something answered, but not with this share (a stopped share says 404).
    Missing,
    /// Nothing answered in time.
    Unreachable,
}

/// Ask `url` for its first byte, within `timeout`. Used to pick which of a LAN
/// sender's addresses this device can actually reach. It asks for the share
/// itself rather than a health check, so an unrelated server that happens to
/// sit at one of those addresses on this network can't be mistaken for it.
pub async fn probe(url: &str, timeout: Duration) -> Probe {
    let Ok(client) = http_client(url) else { return Probe::Unreachable };
    match client.get(url).header(RANGE, "bytes=0-0").timeout(timeout).send().await {
        Ok(resp) if resp.status().is_success() => Probe::Serves,
        Ok(_) => Probe::Missing,
        Err(_) => Probe::Unreachable,
    }
}

/// Minimal percent-decoder — enough to turn `Some%20Movie.mkv` back into a
/// filename. Invalid escapes are left verbatim rather than dropped.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[async_trait]
impl Transport for HttpTransport {
    fn scheme(&self) -> &'static str {
        "http"
    }

    fn describe(&self) -> String {
        self.url.clone()
    }

    /// Probes with a one-byte range request. That single call answers both
    /// questions at once — a `206` proves range support *and* carries the total
    /// size in `Content-Range`, where a `HEAD` would leave range support a
    /// guess (many servers advertise `Accept-Ranges` and then ignore ranges).
    async fn stat(&self) -> Result<SourceMeta> {
        let resp = self
            .client
            .get(&self.url)
            .header(RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(request_failed)?;

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Err(EngineError::Other(SHARE_GONE.into()));
        }
        if !status.is_success() {
            return Err(EngineError::Transport(format!(
                "source returned HTTP {status}"
            )));
        }

        let headers = resp.headers().clone();
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let name = headers
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split("filename=").nth(1))
            .map(|v| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| self.name_from_url());

        let (size, supports_ranges) = if status == StatusCode::PARTIAL_CONTENT {
            let total = headers
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit('/').next())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0);
            (total, true)
        } else {
            let len = headers
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let advertised = headers
                .get(ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.eq_ignore_ascii_case("bytes"))
                .unwrap_or(false);
            // It answered a range request with the whole body, so ranges are
            // not actually honoured whatever the header claims.
            let _ = advertised;
            (len, false)
        };

        Ok(SourceMeta { size, name, content_type, supports_ranges })
    }

    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()> {
        if len == 0 {
            out.clear();
            return Ok(());
        }
        let end = offset + len as u64 - 1;
        let mut resp = self
            .client
            .get(&self.url)
            .header(RANGE, format!("bytes={offset}-{end}"))
            .send()
            .await
            .map_err(request_failed)?;

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            // Not retryable: a stopped share stays stopped.
            return Err(EngineError::Other(SHARE_GONE.into()));
        }
        if status == StatusCode::OK && offset > 0 {
            // Whole body for a mid-file range: we would have to download from
            // zero to reach `offset`. Refuse rather than silently burn traffic.
            return Err(EngineError::NoRangeSupport);
        }
        if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
            return Err(EngineError::Transport(format!(
                "range request failed with HTTP {status}"
            )));
        }

        out.clear();
        let want = len as usize;
        while let Some(c) = resp.chunk().await.map_err(request_failed)? {
            let remaining = want - out.len();
            if c.len() >= remaining {
                out.extend_from_slice(&c[..remaining]);
                break;
            }
            out.extend_from_slice(&c);
        }

        if out.len() != want {
            return Err(EngineError::Transport(format!(
                "short read at {offset}: got {} of {want} bytes",
                out.len()
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retry::{read_range_retrying, RetryPolicy};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    /// A minimal range-capable server over an in-memory body, optionally
    /// failing the first `fail_times` requests to exercise retry.
    fn spawn_server(body: Vec<u8>, fail_times: u32, honour_ranges: bool) -> (String, Arc<AtomicU32>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let hits2 = hits.clone();
        std::thread::spawn(move || {
            let mut failed = 0u32;
            for req in server.incoming_requests() {
                hits2.fetch_add(1, Ordering::Relaxed);
                if failed < fail_times {
                    failed += 1;
                    let _ = req.respond(tiny_http::Response::from_string("boom").with_status_code(503));
                    continue;
                }
                let range = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| {
                        let v = h.value.as_str().strip_prefix("bytes=")?.to_string();
                        let mut it = v.splitn(2, '-');
                        let s: u64 = it.next()?.parse().ok()?;
                        let e = it.next().unwrap_or("");
                        Some((s, if e.is_empty() { None } else { e.parse::<u64>().ok() }))
                    });
                let total = body.len() as u64;
                match (range, honour_ranges) {
                    (Some((s, e)), true) => {
                        let e = e.unwrap_or(total - 1).min(total - 1);
                        let slice = body[s as usize..=(e as usize)].to_vec();
                        let n = slice.len();
                        let mut r = tiny_http::Response::new(
                            tiny_http::StatusCode(206),
                            vec![],
                            std::io::Cursor::new(slice),
                            Some(n),
                            None,
                        );
                        let _ = r.add_header(
                            tiny_http::Header::from_bytes("Content-Range", format!("bytes {s}-{e}/{total}")).unwrap(),
                        );
                        let _ = r.add_header(tiny_http::Header::from_bytes("Accept-Ranges", "bytes").unwrap());
                        let _ = req.respond(r);
                    }
                    _ => {
                        let n = body.len();
                        let mut r = tiny_http::Response::new(
                            tiny_http::StatusCode(200),
                            vec![],
                            std::io::Cursor::new(body.clone()),
                            Some(n),
                            None,
                        );
                        let _ = r.add_header(tiny_http::Header::from_bytes("Accept-Ranges", "bytes").unwrap());
                        let _ = req.respond(r);
                    }
                }
            }
        });
        (format!("http://127.0.0.1:{port}/Movie.mkv"), hits)
    }

    fn body(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 253) as u8).collect()
    }

    #[tokio::test]
    async fn stat_reports_size_name_and_range_support() {
        let data = body(5000);
        let (url, _) = spawn_server(data.clone(), 0, true);
        let t = HttpTransport::new(&url).unwrap();
        let meta = t.stat().await.unwrap();
        assert_eq!(meta.size, 5000);
        assert_eq!(meta.name, "Movie.mkv");
        assert!(meta.supports_ranges);
    }

    #[tokio::test]
    async fn stat_detects_a_server_that_ignores_ranges() {
        let (url, _) = spawn_server(body(5000), 0, false);
        let meta = HttpTransport::new(&url).unwrap().stat().await.unwrap();
        assert!(!meta.supports_ranges, "a 200 to a range request means no seeking");
        assert_eq!(meta.size, 5000);
    }

    #[tokio::test]
    async fn read_range_returns_exactly_the_requested_bytes() {
        let data = body(5000);
        let (url, _) = spawn_server(data.clone(), 0, true);
        let t = HttpTransport::new(&url).unwrap();
        let mut buf = Vec::new();
        t.read_range(1000, 256, &mut buf).await.unwrap();
        assert_eq!(buf, &data[1000..1256]);

        // Tail chunk, shorter than a full chunk.
        t.read_range(4900, 100, &mut buf).await.unwrap();
        assert_eq!(buf, &data[4900..5000]);
    }

    #[tokio::test]
    async fn read_range_reuses_the_callers_allocation() {
        let (url, _) = spawn_server(body(5000), 0, true);
        let t = HttpTransport::new(&url).unwrap();
        let mut buf = Vec::with_capacity(4096);
        let ptr = buf.as_ptr();
        t.read_range(0, 256, &mut buf).await.unwrap();
        t.read_range(256, 256, &mut buf).await.unwrap();
        assert_eq!(ptr, buf.as_ptr(), "pooled buffer must not be reallocated");
    }

    #[tokio::test]
    async fn mid_file_read_against_a_non_range_server_is_refused() {
        let (url, _) = spawn_server(body(5000), 0, false);
        let t = HttpTransport::new(&url).unwrap();
        let mut buf = Vec::new();
        let err = t.read_range(1000, 100, &mut buf).await.unwrap_err();
        assert!(matches!(err, EngineError::NoRangeSupport));
    }

    #[tokio::test]
    async fn retry_rides_out_transient_failures() {
        let data = body(5000);
        let (url, hits) = spawn_server(data.clone(), 2, true);
        let t = HttpTransport::new(&url).unwrap();
        let mut buf = Vec::new();
        let policy = RetryPolicy { attempts: 4, base_delay_ms: 10, max_delay_ms: 50 };
        read_range_retrying(&t, 0, 128, &mut buf, policy).await.unwrap();
        assert_eq!(buf, &data[..128]);
        assert_eq!(hits.load(Ordering::Relaxed), 3, "two failures then success");
    }

    #[tokio::test]
    async fn retry_gives_up_and_reports_the_last_error() {
        let (url, _) = spawn_server(body(100), 99, true);
        let t = HttpTransport::new(&url).unwrap();
        let mut buf = Vec::new();
        let policy = RetryPolicy { attempts: 2, base_delay_ms: 5, max_delay_ms: 10 };
        assert!(read_range_retrying(&t, 0, 10, &mut buf, policy).await.is_err());
    }

    #[test]
    fn derives_a_name_from_the_url_when_the_server_offers_none() {
        let t = HttpTransport::new("http://h:1/a/b/Some%20Movie.mkv?token=xyz").unwrap();
        assert_eq!(t.name_from_url(), "Some Movie.mkv");
        // A bare host must not become the filename.
        assert_eq!(HttpTransport::new("http://h:1/").unwrap().name_from_url(), "download");
        assert_eq!(HttpTransport::new("http://h:1").unwrap().name_from_url(), "download");
    }

    #[test]
    fn percent_decoder_leaves_broken_escapes_alone() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
