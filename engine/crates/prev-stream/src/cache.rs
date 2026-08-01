//! The rolling chunk cache.
//!
//! This is the piece that makes a 40 GB film cost ~200 MB of RAM and 0 bytes of
//! disk. Chunks live here only while they are near the playhead:
//!
//! ```text
//!            evicted        kept for rewind      playhead     prefetched
//!   ... ──────────────┤ ◄──── behind ────► │ ▓▓▓ │ ◄──── ahead ────► ├── not yet fetched
//! ```
//!
//! Insertion is what enforces the ceiling: before a chunk goes in, whatever is
//! furthest from the playhead comes out. There is no background sweeper to fall
//! behind, so `bytes` can never exceed `limit`.

use prev_core::ChunkPlan;
use std::collections::BTreeMap;
use std::sync::Arc;

pub type Chunk = Arc<Vec<u8>>;

pub struct RingCache {
    chunks: BTreeMap<u32, Chunk>,
    bytes: u64,
    limit: u64,
    /// Chunks kept behind the playhead so a small rewind doesn't re-download.
    behind: u32,
    evictions: u64,
}

impl RingCache {
    pub fn new(limit: u64, behind_chunks: u32) -> Self {
        Self { chunks: BTreeMap::new(), bytes: 0, limit: limit.max(1), behind: behind_chunks, evictions: 0 }
    }

    pub fn get(&self, index: u32) -> Option<Chunk> {
        self.chunks.get(&index).cloned()
    }

    pub fn has(&self, index: u32) -> bool {
        self.chunks.contains_key(&index)
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn evictions(&self) -> u64 {
        self.evictions
    }

    /// Contiguous bytes buffered ahead of `offset` — what a player would call
    /// "how long until it stalls".
    pub fn buffered_ahead(&self, plan: &ChunkPlan, offset: u64) -> u64 {
        if plan.total == 0 {
            return 0;
        }
        let start = plan.index_of(offset);
        let mut end = start;
        while end < plan.count() && self.chunks.contains_key(&end) {
            end += 1;
        }
        if end == start {
            return 0;
        }
        (plan.offset(end - 1) + plan.len_of(end - 1) as u64).saturating_sub(offset)
    }

    /// Contiguous bytes retained behind `offset`.
    pub fn buffered_behind(&self, plan: &ChunkPlan, offset: u64) -> u64 {
        let current = plan.index_of(offset);
        let mut first = current;
        while first > 0 && self.chunks.contains_key(&(first - 1)) {
            first -= 1;
        }
        offset.saturating_sub(plan.offset(first))
    }

    /// Insert a chunk, evicting whatever is least useful until it fits.
    ///
    /// Returns whether the chunk was retained. A chunk that is *less* useful
    /// than everything already resident is deliberately not cached: caching it
    /// would mean evicting a chunk the player needs sooner, which the caller
    /// would then re-fetch, evicting this one again — the classic thrash.
    pub fn insert(&mut self, index: u32, data: Chunk, playhead_index: u32) -> bool {
        if self.chunks.contains_key(&index) {
            return true;
        }
        let size = data.len() as u64;
        if !self.make_room(size, playhead_index, index) {
            return false;
        }
        self.bytes += size;
        self.chunks.insert(index, data);
        true
    }

    /// How droppable a chunk is: bigger means evict sooner.
    ///
    /// Distance from the playhead drives it, doubled so that at equal distance
    /// history loses to prefetch — the player is about to need what is ahead,
    /// and has already seen what is behind. Anything older than the rewind
    /// window is worthless and goes first.
    fn evict_score(&self, index: u32, playhead: u32) -> u64 {
        if index >= playhead {
            2 * (index - playhead) as u64
        } else {
            let back = (playhead - index) as u64;
            if back > self.behind as u64 {
                u64::MAX
            } else {
                2 * back + 1
            }
        }
    }

    /// Free space for `needed` bytes. Returns false if that would mean evicting
    /// something more useful than the incoming chunk.
    fn make_room(&mut self, needed: u64, playhead: u32, incoming: u32) -> bool {
        if needed > self.limit {
            // Degenerate config: one chunk larger than the whole cache. Serve
            // it rather than deadlocking, but keep nothing.
            self.clear();
            return true;
        }
        let incoming_score = self.evict_score(incoming, playhead);
        while self.bytes + needed > self.limit {
            let Some(victim) = self
                .chunks
                .keys()
                .copied()
                // Reverse(i) breaks ties toward the oldest chunk: several
                // chunks can be equally stale, and `max_by_key` would
                // otherwise keep picking the newest of them and never free
                // the ones that have been dead longest.
                .max_by_key(|&i| (self.evict_score(i, playhead), std::cmp::Reverse(i)))
            else {
                return true; // cache is empty; the chunk fits by definition
            };
            if self.evict_score(victim, playhead) <= incoming_score {
                return false;
            }
            if let Some(c) = self.chunks.remove(&victim) {
                self.bytes -= c.len() as u64;
                self.evictions += 1;
            }
        }
        true
    }

    /// How many chunks of `chunk_size` this cache can hold at once. The
    /// prefetcher uses this to size its window, so it never asks for more than
    /// can be kept.
    pub fn capacity_chunks(&self, chunk_size: u32) -> u32 {
        (self.limit / chunk_size.max(1) as u64).max(1) as u32
    }

    /// Drop everything — what happens the moment playback stops.
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }

    pub fn resident_indices(&self) -> Vec<u32> {
        self.chunks.keys().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(n: usize) -> Chunk {
        Arc::new(vec![0u8; n])
    }

    #[test]
    fn never_exceeds_its_limit() {
        let mut c = RingCache::new(1000, 2);
        for i in 0..50u32 {
            c.insert(i, chunk(100), i);
            assert!(c.bytes() <= 1000, "cache blew its budget at chunk {i}: {}", c.bytes());
        }
        assert!(c.evictions() > 0, "a bounded cache must actually evict");
    }

    #[test]
    fn keeps_a_rewind_window_and_drops_older_history() {
        let mut c = RingCache::new(500, 2); // room for 5 chunks of 100
        for i in 0..10u32 {
            c.insert(i, chunk(100), i);
        }
        // Playhead is at 9; chunks 7 and 8 are the rewind window and must survive.
        let resident = c.resident_indices();
        assert!(resident.contains(&9));
        assert!(resident.contains(&8), "a small rewind must not re-download: {resident:?}");
        assert!(!resident.contains(&0), "ancient history must be gone: {resident:?}");
    }

    #[test]
    fn prefers_evicting_stale_history_over_prefetch() {
        let mut c = RingCache::new(400, 1); // 4 chunks
        // Buffered behind (0,1) and ahead (5,6) with the playhead at 5.
        c.insert(0, chunk(100), 5);
        c.insert(1, chunk(100), 5);
        c.insert(5, chunk(100), 5);
        c.insert(6, chunk(100), 5);
        // A new prefetch at 7 must cost history, not the chunk after the playhead.
        c.insert(7, chunk(100), 5);
        let resident = c.resident_indices();
        assert!(resident.contains(&5) && resident.contains(&6) && resident.contains(&7));
        assert!(!resident.contains(&0), "oldest history evicted first: {resident:?}");
    }

    #[test]
    fn reports_the_buffer_a_player_can_see() {
        let plan = ChunkPlan::new(1000, prev_core::MIN_CHUNK_SIZE);
        let mut c = RingCache::new(10_000_000, 4);
        assert_eq!(c.buffered_ahead(&plan, 0), 0);
        c.insert(0, chunk(1000), 0);
        assert_eq!(c.buffered_ahead(&plan, 0), 1000);
        assert_eq!(c.buffered_ahead(&plan, 400), 600);

        let plan = ChunkPlan::new(300_000, 100_000);
        let mut c = RingCache::new(10_000_000, 4);
        c.insert(0, chunk(100_000), 0);
        c.insert(1, chunk(100_000), 0);
        assert_eq!(c.buffered_ahead(&plan, 0), 200_000);
        assert_eq!(c.buffered_ahead(&plan, 250_000), 0, "a hole means zero buffer");
        assert_eq!(c.buffered_behind(&plan, 150_000), 150_000);
    }

    #[test]
    fn clearing_releases_everything() {
        let mut c = RingCache::new(10_000, 2);
        for i in 0..5 {
            c.insert(i, chunk(100), i);
        }
        c.clear();
        assert_eq!(c.bytes(), 0);
        assert!(c.is_empty(), "closing playback must free the whole buffer");
    }

    #[test]
    fn a_chunk_larger_than_the_limit_still_gets_served() {
        // Degenerate config, but the player must not deadlock over it.
        let mut c = RingCache::new(50, 1);
        c.insert(0, chunk(100), 0);
        assert!(c.has(0));
    }
}
