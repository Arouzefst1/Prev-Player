//! Fixed-capacity buffer pool.
//!
//! The engine never allocates per chunk. It creates N reusable buffers up front
//! and workers borrow one for the lifetime of a chunk (fetch → verify → write →
//! release). The semaphore means "no free buffer" naturally back-pressures the
//! network layer instead of growing the heap, so peak RAM is
//! `capacity * chunk_size` no matter whether the media is 40 MB or 400 GB.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PoolStats {
    pub capacity: usize,
    pub chunk_size: usize,
    /// Buffers currently checked out by workers.
    pub in_use: usize,
    /// Upper bound on bytes this pool can ever hold.
    pub max_bytes: usize,
}

pub struct MemoryPool {
    chunk_size: usize,
    capacity: usize,
    sem: Arc<Semaphore>,
    free: Mutex<Vec<Vec<u8>>>,
    in_use: AtomicUsize,
}

impl MemoryPool {
    /// `capacity` buffers of `chunk_size` bytes each.
    pub fn new(chunk_size: usize, capacity: usize) -> Arc<Self> {
        let capacity = capacity.max(1);
        Arc::new(Self {
            chunk_size,
            capacity,
            sem: Arc::new(Semaphore::new(capacity)),
            free: Mutex::new(Vec::with_capacity(capacity)),
            in_use: AtomicUsize::new(0),
        })
    }

    /// Size a pool from a byte budget, e.g. 128 MB of 4 MB chunks → 32 buffers.
    pub fn with_budget(chunk_size: usize, budget_bytes: usize) -> Arc<Self> {
        Self::new(chunk_size, (budget_bytes / chunk_size.max(1)).max(2))
    }

    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn stats(&self) -> PoolStats {
        PoolStats {
            capacity: self.capacity,
            chunk_size: self.chunk_size,
            in_use: self.in_use.load(Ordering::Relaxed),
            max_bytes: self.capacity * self.chunk_size,
        }
    }

    /// Borrow a buffer, waiting if every buffer is currently in flight.
    pub async fn acquire(self: &Arc<Self>) -> PooledBuf {
        let permit = self
            .sem
            .clone()
            .acquire_owned()
            .await
            .expect("memory pool semaphore is never closed");
        let buf = self
            .free
            .lock()
            .unwrap()
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(self.chunk_size));
        self.in_use.fetch_add(1, Ordering::Relaxed);
        PooledBuf { buf: Some(buf), pool: self.clone(), _permit: permit }
    }
}

/// A buffer on loan from a [`MemoryPool`]; returns itself on drop.
pub struct PooledBuf {
    buf: Option<Vec<u8>>,
    pool: Arc<MemoryPool>,
    _permit: OwnedSemaphorePermit,
}

impl PooledBuf {
    /// Resize to exactly `len` bytes of scratch space, ready to be filled.
    pub fn prepare(&mut self, len: usize) -> &mut [u8] {
        let b = self.buf.as_mut().expect("buffer is only taken on drop");
        b.clear();
        b.resize(len, 0);
        b.as_mut_slice()
    }

    pub fn as_slice(&self) -> &[u8] {
        self.buf.as_ref().expect("buffer is only taken on drop")
    }

    pub fn as_mut_vec(&mut self) -> &mut Vec<u8> {
        self.buf.as_mut().expect("buffer is only taken on drop")
    }

    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl std::ops::Deref for PooledBuf {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.as_slice()
    }
}

impl Drop for PooledBuf {
    fn drop(&mut self) {
        if let Some(mut b) = self.buf.take() {
            self.pool.in_use.fetch_sub(1, Ordering::Relaxed);
            // Keep the allocation, drop the contents. Buffers that somehow grew
            // past the chunk size are let go rather than kept resident forever.
            if b.capacity() <= self.pool.chunk_size * 2 {
                b.clear();
                let mut free = self.pool.free.lock().unwrap();
                if free.len() < self.pool.capacity {
                    free.push(b);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn buffers_are_reused_not_reallocated() {
        let pool = MemoryPool::new(1024, 2);
        let ptr = {
            let mut b = pool.acquire().await;
            b.prepare(1024);
            b.as_slice().as_ptr()
        };
        let mut b2 = pool.acquire().await;
        b2.prepare(1024);
        assert_eq!(ptr, b2.as_slice().as_ptr(), "the same allocation must come back");
    }

    #[tokio::test]
    async fn capacity_is_a_hard_ceiling() {
        let pool = MemoryPool::new(1024, 2);
        let a = pool.acquire().await;
        let b = pool.acquire().await;
        assert_eq!(pool.stats().in_use, 2);
        // A third acquire must block until one is returned.
        let timed = tokio::time::timeout(std::time::Duration::from_millis(50), pool.acquire()).await;
        assert!(timed.is_err(), "pool must back-pressure instead of allocating");
        drop(a);
        let third = tokio::time::timeout(std::time::Duration::from_millis(500), pool.acquire()).await;
        assert!(third.is_ok(), "returning a buffer must unblock a waiter");
        drop(b);
    }

    #[tokio::test]
    async fn stats_track_checkouts() {
        let pool = MemoryPool::with_budget(4 * 1024 * 1024, 128 * 1024 * 1024);
        assert_eq!(pool.capacity(), 32);
        assert_eq!(pool.stats().max_bytes, 128 * 1024 * 1024);
        {
            let _b = pool.acquire().await;
            assert_eq!(pool.stats().in_use, 1);
        }
        assert_eq!(pool.stats().in_use, 0);
    }
}
