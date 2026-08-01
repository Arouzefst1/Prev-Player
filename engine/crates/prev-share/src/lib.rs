//! Sender side of a share.
//!
//! Nothing is uploaded and nothing is copied. A tiny HTTP server streams the
//! bytes straight off the sender's disk, and the share link carries everything
//! the receiver needs to reach it. Stop the share (or quit the app) and the
//! link is dead — that is the whole "PrevPlayer never becomes a storage
//! provider" principle, implemented.
//!
//! ```text
//!   GET /s/<id>          single file, honours Range
//!   GET /f/<id>          folder manifest (JSON)
//!   GET /f/<id>/<n>      file n of a folder share, honours Range
//!   GET /h/<id>[/<n>]    whole-file SHA-256, computed lazily on first ask
//!   GET /health          liveness probe
//! ```

pub mod hashing;
mod server;

pub use hashing::{HashState, LazyHash};
pub use server::{ActiveShare, ShareServer};

pub use prev_core::content_type;
use prev_core::{EngineError, Result};
use std::net::UdpSocket;

/// Best-effort local IP on the active network — the address other devices dial.
///
/// Connecting a UDP socket sends no packets; it just asks the routing table
/// which interface would be used, which is exactly the address we want.
pub fn local_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

pub fn require_local_ip() -> Result<String> {
    local_ip().ok_or_else(|| {
        EngineError::Other("Could not detect a local network address — are you connected to Wi-Fi or Ethernet?".into())
    })
}
