//! Which chunks do we already have?
//!
//! A packed bitset — one bit per chunk. This is the *entire* resume state: a
//! 100 GB download tracks its progress in under a kilobyte, which is why it can
//! be flushed to SQLite frequently without the write cost mattering.

use crate::chunk::ChunkPlan;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkMap {
    count: u32,
    words: Vec<u64>,
    done: u32,
}

impl ChunkMap {
    pub fn new(count: u32) -> Self {
        let words = ((count as usize) + 63) / 64;
        Self { count, words: vec![0; words], done: 0 }
    }

    /// A map with every chunk already present (used for "download + watch"
    /// where the source is a fully local file).
    pub fn full(count: u32) -> Self {
        let mut m = Self::new(count);
        for i in 0..count {
            m.set(i);
        }
        m
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    pub fn done(&self) -> u32 {
        self.done
    }

    pub fn is_complete(&self) -> bool {
        self.done == self.count
    }

    pub fn has(&self, idx: u32) -> bool {
        if idx >= self.count {
            return false;
        }
        let (w, b) = (idx as usize / 64, idx as usize % 64);
        self.words[w] & (1u64 << b) != 0
    }

    /// Mark a chunk present. Returns `true` if this call changed anything.
    pub fn set(&mut self, idx: u32) -> bool {
        if idx >= self.count || self.has(idx) {
            return false;
        }
        let (w, b) = (idx as usize / 64, idx as usize % 64);
        self.words[w] |= 1u64 << b;
        self.done += 1;
        true
    }

    /// Mark a chunk missing (integrity failure → re-fetch just this one).
    pub fn unset(&mut self, idx: u32) -> bool {
        if idx >= self.count || !self.has(idx) {
            return false;
        }
        let (w, b) = (idx as usize / 64, idx as usize % 64);
        self.words[w] &= !(1u64 << b);
        self.done -= 1;
        true
    }

    /// First missing chunk at or after `start`, wrapping is *not* performed.
    pub fn first_missing_from(&self, start: u32) -> Option<u32> {
        (start..self.count).find(|&i| !self.has(i))
    }

    pub fn missing(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.count).filter(move |&i| !self.has(i))
    }

    /// Bytes already on disk, accounting for a short final chunk.
    pub fn bytes_done(&self, plan: &ChunkPlan) -> u64 {
        if self.count == 0 || self.done == 0 {
            return 0;
        }
        let last = self.count - 1;
        if self.has(last) {
            (self.done as u64 - 1) * plan.chunk_size as u64 + plan.len_of(last) as u64
        } else {
            self.done as u64 * plan.chunk_size as u64
        }
    }

    /// Contiguous bytes available from `offset` onwards — how far a player can
    /// read before it would stall.
    pub fn contiguous_from(&self, plan: &ChunkPlan, offset: u64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let start = plan.index_of(offset);
        let mut end = start;
        while end < self.count && self.has(end) {
            end += 1;
        }
        if end == start {
            return 0;
        }
        let avail_to = plan.offset(end - 1) + plan.len_of(end - 1) as u64;
        avail_to.saturating_sub(offset)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.words.len() * 8);
        for w in &self.words {
            out.extend_from_slice(&w.to_le_bytes());
        }
        out
    }

    pub fn from_bytes(count: u32, bytes: &[u8]) -> Self {
        let mut m = Self::new(count);
        for (i, c) in bytes.chunks(8).enumerate() {
            if i >= m.words.len() {
                break;
            }
            let mut buf = [0u8; 8];
            buf[..c.len()].copy_from_slice(c);
            m.words[i] = u64::from_le_bytes(buf);
        }
        // Zero any bits past the end so a corrupt/oversized blob can't inflate
        // the completion count.
        let tail = (count % 64) as u32;
        if tail != 0 {
            if let Some(last) = m.words.last_mut() {
                *last &= (1u64 << tail) - 1;
            }
        }
        m.done = m.words.iter().map(|w| w.count_ones()).sum();
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::MIN_CHUNK_SIZE;

    #[test]
    fn set_and_unset_track_completion() {
        let mut m = ChunkMap::new(100);
        assert!(!m.is_complete());
        assert!(m.set(5));
        assert!(!m.set(5), "setting twice must not double-count");
        assert_eq!(m.done(), 1);
        assert!(m.unset(5));
        assert_eq!(m.done(), 0);
        assert!(!m.unset(5));
        assert!(!m.set(100), "out of range set is a no-op");
    }

    #[test]
    fn roundtrips_through_bytes() {
        let mut m = ChunkMap::new(200);
        for i in [0u32, 1, 63, 64, 65, 199] {
            m.set(i);
        }
        let restored = ChunkMap::from_bytes(200, &m.to_bytes());
        assert_eq!(restored, m);
        assert_eq!(restored.done(), 6);
        assert!(restored.has(199));
        assert!(!restored.has(198));
    }

    #[test]
    fn oversized_blob_cannot_inflate_progress() {
        // 70 chunks = 2 words; a blob with every bit set must still report 70.
        let blob = vec![0xffu8; 16];
        let m = ChunkMap::from_bytes(70, &blob);
        assert_eq!(m.done(), 70);
        assert!(m.is_complete());
    }

    #[test]
    fn bytes_done_accounts_for_short_final_chunk() {
        let plan = ChunkPlan::new(MIN_CHUNK_SIZE as u64 * 2 + 100, MIN_CHUNK_SIZE);
        let mut m = ChunkMap::new(plan.count());
        assert_eq!(m.bytes_done(&plan), 0);
        m.set(0);
        assert_eq!(m.bytes_done(&plan), MIN_CHUNK_SIZE as u64);
        m.set(2); // the 100-byte tail
        assert_eq!(m.bytes_done(&plan), MIN_CHUNK_SIZE as u64 + 100);
        m.set(1);
        assert_eq!(m.bytes_done(&plan), plan.total);
    }

    #[test]
    fn contiguous_from_stops_at_first_hole() {
        let plan = ChunkPlan::new(MIN_CHUNK_SIZE as u64 * 5, MIN_CHUNK_SIZE);
        let mut m = ChunkMap::new(plan.count());
        m.set(0);
        m.set(1);
        m.set(3);
        assert_eq!(m.contiguous_from(&plan, 0), MIN_CHUNK_SIZE as u64 * 2);
        // Halfway into chunk 0, two chunks are still readable minus what we skipped.
        assert_eq!(m.contiguous_from(&plan, 100), MIN_CHUNK_SIZE as u64 * 2 - 100);
        assert_eq!(m.contiguous_from(&plan, MIN_CHUNK_SIZE as u64 * 2), 0);
    }

    #[test]
    fn missing_lists_holes_in_order() {
        let mut m = ChunkMap::new(5);
        m.set(1);
        m.set(3);
        assert_eq!(m.missing().collect::<Vec<_>>(), vec![0, 2, 4]);
        assert_eq!(m.first_missing_from(2), Some(2));
        assert_eq!(m.first_missing_from(5), None);
    }
}
