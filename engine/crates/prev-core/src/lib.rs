//! Core vocabulary of the PrevPlayer transfer engine.
//!
//! Everything in the engine is expressed in terms of **chunks**, never files.
//! A [`ChunkPlan`] turns a byte length into a fixed grid of chunk indices; a
//! [`ChunkMap`] records which of those chunks are present; a [`MemoryPool`]
//! hands out the (few, reused) buffers those chunks live in while in flight.
//!
//! This crate is deliberately free of I/O, networking and Tauri: it is pure
//! data structures, so it can be unit-tested exhaustively and reused by the
//! download engine, the stream engine and the share server alike.

pub mod chunk;
pub mod error;
pub mod event;
pub mod hash;
pub mod link;
pub mod map;
pub mod meter;
pub mod mime;
pub mod pool;
pub mod posio;
pub mod range;

pub use chunk::{ChunkPlan, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE};
pub use error::{EngineError, Result};
pub use event::{
    null_sink, DownloadProgress, EngineEvent, EventLog, EventSink, StreamStats, TransferState,
    Verification,
};
pub use hash::{sha256_hex, Sha256Stream};
pub use link::{ShareFile, ShareKind, ShareLink, SCHEME};
pub use map::ChunkMap;
pub use meter::SpeedMeter;
pub use mime::{content_type, is_media};
pub use pool::{MemoryPool, PoolStats, PooledBuf};
pub use range::{parse_range, RangeReq};
