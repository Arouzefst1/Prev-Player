//! Retry with exponential backoff.
//!
//! Chunk reads are the perfect retry unit: a failed chunk costs at most one
//! chunk of re-transfer, and the chunk map means a retry never disturbs
//! anything already on disk.

use crate::Transport;
use prev_core::Result;
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { attempts: 4, base_delay_ms: 250, max_delay_ms: 4_000 }
    }
}

impl RetryPolicy {
    /// Used by the stream engine, where a stalled chunk means a stalled picture
    /// — better to fail fast and re-request than to sit in backoff.
    pub fn realtime() -> Self {
        Self { attempts: 3, base_delay_ms: 100, max_delay_ms: 800 }
    }

    pub fn delay_for(&self, attempt: u32) -> Duration {
        let ms = self
            .base_delay_ms
            .saturating_mul(1u64 << attempt.min(10))
            .min(self.max_delay_ms);
        Duration::from_millis(ms)
    }
}

/// Read a range, retrying retryable failures. Non-retryable errors (a bad link,
/// a source with no range support) fail immediately — backing off wouldn't help.
pub async fn read_range_retrying(
    transport: &dyn Transport,
    offset: u64,
    len: u32,
    out: &mut Vec<u8>,
    policy: RetryPolicy,
) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        match transport.read_range(offset, len, out).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                attempt += 1;
                if attempt >= policy.attempts.max(1) || !e.is_retryable() {
                    return Err(e);
                }
                tokio::time::sleep(policy.delay_for(attempt - 1)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        let p = RetryPolicy { attempts: 6, base_delay_ms: 100, max_delay_ms: 500 };
        assert_eq!(p.delay_for(0), Duration::from_millis(100));
        assert_eq!(p.delay_for(1), Duration::from_millis(200));
        assert_eq!(p.delay_for(2), Duration::from_millis(400));
        assert_eq!(p.delay_for(3), Duration::from_millis(500), "capped");
        assert_eq!(p.delay_for(50), Duration::from_millis(500), "no overflow");
    }
}
