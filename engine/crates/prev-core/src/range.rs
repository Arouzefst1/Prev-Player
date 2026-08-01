//! HTTP `Range` header parsing.
//!
//! Shared by the share server (sending) and the stream server (playing back),
//! because both have to satisfy the same players. Getting this wrong shows up
//! as "seeking doesn't work", so the edge cases are pinned down by tests.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeReq {
    /// No `Range` header — send the whole thing.
    Full,
    /// Inclusive byte range, already clamped to the media.
    Bytes(u64, u64),
    /// Present but unsatisfiable — the caller should answer `416`.
    Unsatisfiable,
}

/// Parse a `Range` header value against a known total size.
///
/// Supports `bytes=a-b`, the open-ended `bytes=a-`, and the suffix form
/// `bytes=-n` that players use to read a container's trailing index. A
/// multi-range request is answered with its first range, which is a legal
/// response and keeps the reader to a single seek.
pub fn parse_range(value: &str, total: u64) -> RangeReq {
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return RangeReq::Unsatisfiable;
    };
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else {
        return RangeReq::Unsatisfiable;
    };
    if total == 0 {
        return RangeReq::Unsatisfiable;
    }
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return RangeReq::Unsatisfiable,
        ("", n) => match n.parse::<u64>() {
            Ok(0) => return RangeReq::Unsatisfiable,
            Ok(n) => (total.saturating_sub(n), total - 1),
            Err(_) => return RangeReq::Unsatisfiable,
        },
        (s, "") => match s.parse::<u64>() {
            Ok(s) => (s, total - 1),
            Err(_) => return RangeReq::Unsatisfiable,
        },
        (s, e) => match (s.parse::<u64>(), e.parse::<u64>()) {
            // Over-asking at the tail is routine; clamp rather than reject.
            (Ok(s), Ok(e)) => (s, e.min(total - 1)),
            _ => return RangeReq::Unsatisfiable,
        },
    };
    if start > end || start >= total {
        return RangeReq::Unsatisfiable;
    }
    RangeReq::Bytes(start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_every_form_players_send() {
        assert_eq!(parse_range("bytes=0-99", 1000), RangeReq::Bytes(0, 99));
        assert_eq!(parse_range("bytes=500-", 1000), RangeReq::Bytes(500, 999));
        assert_eq!(parse_range("bytes=-100", 1000), RangeReq::Bytes(900, 999));
        assert_eq!(parse_range("bytes=900-99999", 1000), RangeReq::Bytes(900, 999));
        assert_eq!(parse_range("bytes=0-0", 1000), RangeReq::Bytes(0, 0));
        assert_eq!(parse_range("bytes=0-9,20-29", 1000), RangeReq::Bytes(0, 9));
        assert_eq!(parse_range(" bytes=10-20 ", 1000), RangeReq::Bytes(10, 20));
    }

    #[test]
    fn rejects_what_cannot_be_served() {
        assert_eq!(parse_range("bytes=1000-", 1000), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("bytes=abc", 1000), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("items=0-1", 1000), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-99", 0), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("bytes=-", 1000), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 1000), RangeReq::Unsatisfiable);
        assert_eq!(parse_range("bytes=50-10", 1000), RangeReq::Unsatisfiable);
    }

    #[test]
    fn a_suffix_longer_than_the_file_means_the_whole_file() {
        assert_eq!(parse_range("bytes=-5000", 1000), RangeReq::Bytes(0, 999));
    }
}
