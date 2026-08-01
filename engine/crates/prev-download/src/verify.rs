//! Integrity.
//!
//! Two levels, because senders differ in what they can afford to publish:
//!
//! * **Per-chunk** — the strongest form. A bad chunk is detected the moment it
//!   arrives, that one chunk is un-marked in the map and re-fetched, and the
//!   rest of the transfer is untouched. Available whenever the source publishes
//!   a piece-hash list (a future torrent-style transport gets this for free).
//! * **Whole-file** — what a LAN share uses. Hashing a 40 GB file just to
//!   advertise it would be absurd, so the sender computes it lazily on first
//!   request and the receiver collects it at the end.
//!
//! When neither is available the transfer still succeeds; it is simply reported
//! as size-verified only, rather than pretending to a guarantee it doesn't have.

use prev_core::{sha256_hex, EngineError, Result, Sha256Stream};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Integrity {
    /// Trust the transport (TCP already checksums; a LAN link with no published
    /// digest lands here).
    #[default]
    None,
    /// One SHA-256 per chunk, index-aligned with the [`prev_core::ChunkPlan`].
    Chunks(Vec<String>),
    /// Whole-file SHA-256, known before the transfer starts.
    Whole(String),
    /// Whole-file SHA-256, fetched from the sender once the transfer completes.
    Deferred { url: String },
}

/// How hard the engine insists on verification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum VerifyPolicy {
    /// Never verify. Fastest; appropriate for a trusted LAN on slow disks.
    Off,
    /// Verify if the source published a digest, otherwise complete anyway.
    #[default]
    WhenAvailable,
    /// Refuse to complete a transfer that cannot be verified.
    Required,
}

/// Outcome, so the UI can be honest about what was actually checked.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerifyOutcome {
    /// Digest matched.
    Verified { sha256: String },
    /// No digest was published; only the byte count is known-good.
    SizeOnly,
    Skipped,
}

impl VerifyOutcome {
    /// Collapse to the flag the UI shows, dropping the digest itself.
    pub fn as_verification(&self) -> prev_core::Verification {
        match self {
            VerifyOutcome::Verified { .. } => prev_core::Verification::Verified,
            VerifyOutcome::SizeOnly => prev_core::Verification::SizeOnly,
            VerifyOutcome::Skipped => prev_core::Verification::Skipped,
        }
    }
}

impl Integrity {
    pub fn chunk_hash(&self, index: u32) -> Option<&str> {
        match self {
            Integrity::Chunks(v) => v.get(index as usize).map(|s| s.as_str()),
            _ => None,
        }
    }

    /// Check a chunk that just arrived. A source with no per-chunk hashes
    /// accepts everything here and relies on the end-of-transfer check.
    pub fn verify_chunk(&self, index: u32, data: &[u8]) -> Result<()> {
        match self.chunk_hash(index) {
            None => Ok(()),
            Some(expected) if sha256_hex(data).eq_ignore_ascii_case(expected) => Ok(()),
            Some(_) => Err(EngineError::Integrity { index }),
        }
    }

    pub fn has_per_chunk(&self) -> bool {
        matches!(self, Integrity::Chunks(_))
    }

    /// The whole-file digest, fetching it from the sender if that's the deal.
    ///
    /// The sender answers `202` while its background hash is still running, so
    /// this polls within a budget rather than failing on the first try.
    pub async fn resolve_whole(&self, budget: Duration) -> Option<String> {
        match self {
            Integrity::Whole(h) => Some(h.clone()),
            Integrity::Deferred { url } => fetch_digest(url, budget).await,
            _ => None,
        }
    }
}

async fn fetch_digest(url: &str, budget: Duration) -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent("PREV-Player/engine")
        .build()
        .ok()?;
    let deadline = std::time::Instant::now() + budget;
    loop {
        if let Ok(resp) = client.get(url).send().await {
            let status = resp.status();
            // 202 is "still hashing, ask again" — and it is *also* a 2xx, so it
            // has to be checked before the success branch or the poll would
            // parse the placeholder body and give up on the first try.
            if status.as_u16() != 202 {
                if status.is_success() {
                    let body = resp.text().await.ok()?;
                    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
                    return v.get("sha256").and_then(|s| s.as_str()).map(|s| s.to_string());
                }
                return None;
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Stream a finished file through SHA-256 and compare.
///
/// Runs on the blocking pool: this is the one place the engine reads a whole
/// file, and it must not stall the async runtime while doing it.
pub async fn verify_file(path: impl AsRef<Path>, expected: &str) -> Result<()> {
    let path = path.as_ref().to_path_buf();
    let expected = expected.to_string();
    tokio::task::spawn_blocking(move || {
        let actual = hash_file_blocking(&path)?;
        if actual.eq_ignore_ascii_case(&expected) {
            Ok(())
        } else {
            Err(EngineError::Other(format!(
                "file failed verification: expected {expected}, got {actual}"
            )))
        }
    })
    .await
    .map_err(|e| EngineError::other(format!("verify task panicked: {e}")))?
}

pub fn hash_file_blocking(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut stream = Sha256Stream::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        stream.update(&buf[..n]);
    }
    Ok(stream.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_chunk_verification_pinpoints_the_bad_chunk() {
        let good = b"chunk-zero";
        let integrity = Integrity::Chunks(vec![sha256_hex(good), sha256_hex(b"chunk-one")]);

        assert!(integrity.verify_chunk(0, good).is_ok());
        let err = integrity.verify_chunk(1, b"corrupted").unwrap_err();
        assert!(matches!(err, EngineError::Integrity { index: 1 }));
        // Beyond the published list there is nothing to check against.
        assert!(integrity.verify_chunk(99, b"anything").is_ok());
    }

    #[test]
    fn no_hashes_means_every_chunk_passes() {
        assert!(Integrity::None.verify_chunk(0, b"whatever").is_ok());
        assert!(!Integrity::None.has_per_chunk());
    }

    #[tokio::test]
    async fn verify_file_accepts_a_match_and_rejects_a_mismatch() {
        let dir = std::env::temp_dir().join(format!("prev-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.bin");
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();

        verify_file(&p, &sha256_hex(&data)).await.unwrap();
        let err = verify_file(&p, &sha256_hex(b"something else")).await.unwrap_err();
        assert!(err.to_string().contains("failed verification"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_known_digest_needs_no_network() {
        let i = Integrity::Whole("abc123".into());
        assert_eq!(i.resolve_whole(Duration::from_millis(1)).await.as_deref(), Some("abc123"));
        assert_eq!(Integrity::None.resolve_whole(Duration::from_millis(1)).await, None);
    }

    #[tokio::test]
    async fn a_deferred_digest_polls_past_the_202_placeholder() {
        // The sender answers 202 while hashing, then 200 with the digest. 202
        // is a 2xx, so a naive success check would stop at the placeholder.
        let server = tiny_server(vec![
            (202, "hashing".to_string()),
            (202, "hashing".to_string()),
            (200, r#"{"sha256":"feedface"}"#.to_string()),
        ]);
        let i = Integrity::Deferred { url: server };
        assert_eq!(
            i.resolve_whole(Duration::from_secs(5)).await.as_deref(),
            Some("feedface")
        );
    }

    /// Serves a scripted sequence of responses, one per request.
    fn tiny_server(script: Vec<(u16, String)>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for (i, mut stream) in listener.incoming().flatten().enumerate() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let (status, body) = script.get(i).cloned().unwrap_or((404, String::new()));
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/h/x")
    }

    #[tokio::test]
    async fn a_deferred_digest_that_never_arrives_gives_up() {
        let i = Integrity::Deferred { url: "http://127.0.0.1:1/h/x".into() };
        assert_eq!(i.resolve_whole(Duration::from_millis(50)).await, None);
    }
}
