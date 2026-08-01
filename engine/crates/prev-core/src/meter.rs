//! Transfer speed / ETA estimation.
//!
//! Instantaneous byte deltas are far too jittery to show a user, so this
//! smooths them with an exponential moving average and derives ETA from the
//! smoothed rate.

use std::time::Instant;

#[derive(Debug)]
pub struct SpeedMeter {
    last_at: Instant,
    last_bytes: u64,
    ewma: f64,
    alpha: f64,
}

impl SpeedMeter {
    pub fn new(initial_bytes: u64) -> Self {
        Self { last_at: Instant::now(), last_bytes: initial_bytes, ewma: 0.0, alpha: 0.3 }
    }

    /// Feed the *cumulative* transferred byte count; returns bytes/sec.
    pub fn sample(&mut self, total_bytes: u64) -> f64 {
        let now = Instant::now();
        let dt = now.duration_since(self.last_at).as_secs_f64();
        if dt < 0.05 {
            return self.ewma;
        }
        let delta = total_bytes.saturating_sub(self.last_bytes) as f64;
        let instant = delta / dt;
        self.ewma = if self.ewma == 0.0 {
            instant
        } else {
            self.alpha * instant + (1.0 - self.alpha) * self.ewma
        };
        self.last_at = now;
        self.last_bytes = total_bytes;
        self.ewma
    }

    pub fn bps(&self) -> f64 {
        self.ewma
    }

    /// Seconds remaining, or `None` while the rate is still unknown/stalled.
    pub fn eta(&self, remaining: u64) -> Option<u64> {
        if self.ewma < 1.0 {
            return None;
        }
        Some((remaining as f64 / self.ewma).round() as u64)
    }
}

/// Human-readable byte size, for CLI and UI alike.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{} {}", n, UNITS[0])
    } else {
        format!("{:.1} {}", v, UNITS[u])
    }
}

pub fn human_duration(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{}h {:02}m", h, m)
    } else if m > 0 {
        format!("{}m {:02}s", m, s)
    } else {
        format!("{}s", s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eta_is_none_until_a_rate_is_known() {
        let m = SpeedMeter::new(0);
        assert_eq!(m.eta(1000), None);
    }

    #[test]
    fn formats_sizes_and_durations() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(40 * 1024 * 1024 * 1024), "40.0 GB");
        assert_eq!(human_duration(45), "45s");
        assert_eq!(human_duration(125), "2m 05s");
        assert_eq!(human_duration(7325), "2h 02m");
    }

    #[test]
    fn smooths_toward_the_real_rate() {
        let mut m = SpeedMeter::new(0);
        // Simulate ~1 MB per 100 ms == ~10 MB/s over several samples.
        let mut total = 0u64;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(60));
            total += 600_000;
            m.sample(total);
        }
        let bps = m.bps();
        assert!(bps > 5_000_000.0 && bps < 20_000_000.0, "unexpected rate: {bps}");
        assert!(m.eta(bps as u64).is_some());
    }
}
