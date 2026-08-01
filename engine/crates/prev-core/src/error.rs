use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("transport error: {0}")]
    Transport(String),

    #[error("invalid share link: {0}")]
    Link(String),

    #[error("integrity check failed for chunk {index}")]
    Integrity { index: u32 },

    #[error("state store error: {0}")]
    State(String),

    #[error("source does not support range requests, which the chunk engine requires")]
    NoRangeSupport,

    #[error("transfer was cancelled")]
    Cancelled,

    #[error("{0}")]
    Other(String),
}

impl EngineError {
    pub fn other(msg: impl std::fmt::Display) -> Self {
        Self::Other(msg.to_string())
    }

    pub fn transport(msg: impl std::fmt::Display) -> Self {
        Self::Transport(msg.to_string())
    }

    /// Worth retrying with backoff? Integrity failures and network hiccups are;
    /// a bad link or a cancelled transfer is not.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Integrity { .. } | Self::Io(_))
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
