//! Events the engine emits outward.
//!
//! The engine never knows about Tauri or React. It pushes plain serialisable
//! events into an [`EventSink`]; the host app decides whether that becomes
//! `app.emit("prev-engine", ..)`, a log line, or a test assertion.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

impl TransferState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Verifying => "verifying",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// What a completed transfer's integrity claim actually rests on. Surfaced so
/// the UI can say "verified" only when that is true.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verification {
    /// A published SHA-256 matched.
    Verified,
    /// No digest was available; the byte count is all that was checked.
    SizeOnly,
    /// Verification was turned off.
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub chunks_done: u32,
    pub chunks_total: u32,
    pub workers: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStats {
    pub id: String,
    /// Byte offset the player is currently reading at.
    pub playhead: u64,
    /// Contiguous bytes buffered ahead of the playhead.
    pub buffered_ahead: u64,
    /// Bytes retained behind the playhead for instant small rewinds.
    pub buffered_behind: u64,
    /// Bytes currently resident in RAM for this session.
    pub cached_bytes: u64,
    /// Configured ceiling for `cached_bytes`.
    pub cache_limit: u64,
    pub chunks_resident: usize,
    /// Chunks fetched from the network since the session started.
    pub fetches: u64,
    /// Bytes written to disk because the user pressed "Save Offline".
    pub saved_bytes: u64,
    pub saving: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineEvent {
    DownloadProgress(DownloadProgress),
    DownloadState {
        id: String,
        name: String,
        state: TransferState,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        verification: Option<Verification>,
    },
    StreamStats(StreamStats),
    StreamState {
        id: String,
        state: TransferState,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A chunk failed verification and is being re-fetched — surfaced because
    /// "download stalled for a moment" is otherwise inexplicable to a user.
    ChunkRepaired {
        id: String,
        index: u32,
    },
}

/// Where events go. Cloneable and cheap; the engine holds one per session.
pub type EventSink = Arc<dyn Fn(EngineEvent) + Send + Sync>;

/// An event sink that throws everything away — the default for tests and for
/// headless use.
pub fn null_sink() -> EventSink {
    Arc::new(|_| {})
}

/// Collects events in memory. Test helper, but also handy for debugging a
/// misbehaving transfer in the real app.
#[derive(Clone, Default)]
pub struct EventLog(Arc<std::sync::Mutex<Vec<EngineEvent>>>);

impl EventLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sink(&self) -> EventSink {
        let inner = self.0.clone();
        Arc::new(move |e| inner.lock().unwrap().push(e))
    }

    pub fn events(&self) -> Vec<EngineEvent> {
        self.0.lock().unwrap().clone()
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_with_a_discriminant_the_ui_can_switch_on() {
        let e = EngineEvent::DownloadState {
            id: "d1".into(),
            name: "Movie.mkv".into(),
            state: TransferState::Running,
            error: None,
            path: None,
            verification: None,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"downloadState\""));
        assert!(json.contains("\"state\":\"running\""));
        assert!(!json.contains("error"), "None fields stay out of the payload");
    }

    #[test]
    fn event_log_captures_what_the_engine_emits() {
        let log = EventLog::new();
        let sink = log.sink();
        sink(EngineEvent::ChunkRepaired { id: "d1".into(), index: 7 });
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn terminal_states_are_terminal() {
        assert!(TransferState::Completed.is_terminal());
        assert!(TransferState::Cancelled.is_terminal());
        assert!(!TransferState::Paused.is_terminal());
    }
}
