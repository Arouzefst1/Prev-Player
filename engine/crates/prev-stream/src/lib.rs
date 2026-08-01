//! Watch Online.
//!
//! ```text
//!   transport ──► rolling RAM buffer ──► local HTTP ──► mpv ──► screen
//!                        │
//!                        └─(optional)─► Movie.mkv.partial   "Save Offline"
//! ```
//!
//! The player is handed an ordinary seekable `http://127.0.0.1:…` URL, so it
//! needs no knowledge of shares, chunks or transports. Behind that URL a
//! [`StreamSession`] keeps only a window of chunks in memory, which is why a
//! 40 GB film streams in a couple of hundred megabytes of RAM and, unless the
//! user asks to save it, never touches the disk at all.

pub mod cache;
pub mod server;
pub mod session;

pub use cache::RingCache;
pub use server::StreamServer;
pub use session::{SaveOutcome, StreamConfig, StreamSession};
