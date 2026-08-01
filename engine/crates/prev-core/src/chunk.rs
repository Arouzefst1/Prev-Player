//! The chunk grid.
//!
//! A [`ChunkPlan`] is the single source of truth for "where does chunk N live
//! in the file". Downloads, streams and integrity checks all derive their byte
//! offsets from it, which is why a resumed transfer must reuse the *same* plan
//! it started with (the chunk size is therefore persisted alongside progress).

use serde::{Deserialize, Serialize};

/// Default chunk size: big enough that per-chunk overhead is negligible, small
/// enough that a rolling stream buffer stays fine-grained.
pub const DEFAULT_CHUNK_SIZE: u32 = 4 * 1024 * 1024;

/// Floor for a chunk size. Anything smaller makes the per-chunk bookkeeping
/// (one HTTP range request, one hash, one map bit) cost more than the payload.
pub const MIN_CHUNK_SIZE: u32 = 64 * 1024;

/// A fixed-size grid laid over a byte length.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkPlan {
    /// Total size of the media in bytes. `0` means "unknown/streaming source".
    pub total: u64,
    /// Size of every chunk except (possibly) the last one.
    pub chunk_size: u32,
}

impl ChunkPlan {
    pub fn new(total: u64, chunk_size: u32) -> Self {
        Self { total, chunk_size: chunk_size.max(MIN_CHUNK_SIZE) }
    }

    /// Pick a sensible chunk size for a given media size.
    ///
    /// Small clips get small chunks so progress feels responsive; multi-hundred
    /// gigabyte files get large chunks so the chunk map and the request count
    /// stay small (a 100 GB file at 16 MB is ~6400 chunks — 800 bytes of map).
    pub fn auto(total: u64) -> Self {
        const MB: u64 = 1024 * 1024;
        let chunk = if total <= 64 * MB {
            MB
        } else if total <= 1024 * MB {
            4 * MB
        } else if total <= 8192 * MB {
            8 * MB
        } else {
            16 * MB
        };
        Self::new(total, chunk as u32)
    }

    /// Number of chunks covering the media.
    pub fn count(&self) -> u32 {
        if self.total == 0 {
            return 0;
        }
        let cs = self.chunk_size as u64;
        ((self.total + cs - 1) / cs) as u32
    }

    /// Byte offset at which chunk `idx` starts.
    pub fn offset(&self, idx: u32) -> u64 {
        idx as u64 * self.chunk_size as u64
    }

    /// Length of chunk `idx` (the final chunk is usually short). `0` if out of range.
    pub fn len_of(&self, idx: u32) -> u32 {
        let off = self.offset(idx);
        if off >= self.total {
            return 0;
        }
        (self.total - off).min(self.chunk_size as u64) as u32
    }

    /// `(offset, len)` of chunk `idx`.
    pub fn range(&self, idx: u32) -> (u64, u32) {
        (self.offset(idx), self.len_of(idx))
    }

    /// Index of the chunk containing `offset`.
    pub fn index_of(&self, offset: u64) -> u32 {
        (offset / self.chunk_size as u64) as u32
    }

    /// Half-open range of chunk indices needed to cover `[start, start + len)`,
    /// clamped to the media. An empty range means the request is out of bounds.
    pub fn indices_for(&self, start: u64, len: u64) -> std::ops::Range<u32> {
        if self.total == 0 || start >= self.total || len == 0 {
            return 0..0;
        }
        let end = start.saturating_add(len).min(self.total);
        let first = self.index_of(start);
        let last = self.index_of(end - 1);
        first..(last + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_every_byte_exactly_once() {
        let plan = ChunkPlan::new(10 * MIN_CHUNK_SIZE as u64 + 7, MIN_CHUNK_SIZE);
        assert_eq!(plan.count(), 11);
        let mut seen = 0u64;
        for i in 0..plan.count() {
            let (off, len) = plan.range(i);
            assert_eq!(off, seen);
            seen += len as u64;
        }
        assert_eq!(seen, plan.total);
        assert_eq!(plan.len_of(10), 7);
        assert_eq!(plan.len_of(11), 0);
    }

    #[test]
    fn exact_multiple_has_no_phantom_chunk() {
        let plan = ChunkPlan::new(4 * MIN_CHUNK_SIZE as u64, MIN_CHUNK_SIZE);
        assert_eq!(plan.count(), 4);
        assert_eq!(plan.len_of(3), MIN_CHUNK_SIZE);
        assert_eq!(plan.len_of(4), 0);
    }

    #[test]
    fn empty_media_has_no_chunks() {
        let plan = ChunkPlan::new(0, MIN_CHUNK_SIZE);
        assert_eq!(plan.count(), 0);
        assert_eq!(plan.indices_for(0, 100), 0..0);
    }

    #[test]
    fn indices_for_clamps_to_media() {
        let plan = ChunkPlan::new(1000, MIN_CHUNK_SIZE); // single chunk
        assert_eq!(plan.indices_for(0, 10), 0..1);
        assert_eq!(plan.indices_for(999, 10_000), 0..1);
        assert_eq!(plan.indices_for(1000, 10), 0..0);

        let plan = ChunkPlan::new(MIN_CHUNK_SIZE as u64 * 3, MIN_CHUNK_SIZE);
        assert_eq!(plan.indices_for(0, MIN_CHUNK_SIZE as u64), 0..1);
        assert_eq!(plan.indices_for(0, MIN_CHUNK_SIZE as u64 + 1), 0..2);
        assert_eq!(plan.indices_for(MIN_CHUNK_SIZE as u64, 1), 1..2);
    }

    #[test]
    fn auto_scales_chunk_size_with_media_size() {
        assert_eq!(ChunkPlan::auto(10 * 1024 * 1024).chunk_size, 1024 * 1024);
        assert_eq!(ChunkPlan::auto(500 * 1024 * 1024).chunk_size, 4 * 1024 * 1024);
        assert_eq!(ChunkPlan::auto(100 * 1024 * 1024 * 1024).chunk_size, 16 * 1024 * 1024);
        // A 100 GB file must stay cheap to track.
        assert!(ChunkPlan::auto(100 * 1024 * 1024 * 1024).count() < 10_000);
    }

    #[test]
    fn chunk_size_never_below_floor() {
        assert_eq!(ChunkPlan::new(1000, 1).chunk_size, MIN_CHUNK_SIZE);
    }
}
