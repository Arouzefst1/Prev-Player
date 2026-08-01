//! Downloads: parallel, resumable, verifiable, and free of chunk files.
//!
//! * [`engine::DownloadEngine`] — schedules workers over a chunk queue.
//! * [`writer::PartialWriter`] — the one `.partial` file everyone writes into.
//! * [`state::StateStore`] — SQLite resume state (a bitmap per download).
//! * [`verify`] — per-chunk repair and whole-file verification.

pub mod engine;
pub mod state;
pub mod verify;
pub mod writer;

pub use engine::{default_workers, sanitise, DownloadConfig, DownloadEngine};
pub use state::{DownloadRecord, StateStore};
pub use verify::{Integrity, VerifyOutcome, VerifyPolicy};
pub use writer::PartialWriter;
