//! Local-file transport.
//!
//! Useful in three places: tests, sharing a file with yourself, and the
//! "download + watch" case where the stream engine reads completed ranges of a
//! `.partial` while workers are still filling the holes.

use crate::{SourceMeta, Transport};
use async_trait::async_trait;
use prev_core::{posio, EngineError, Result};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub struct FileTransport {
    path: PathBuf,
    handle: OnceLock<Arc<File>>,
}

impl FileTransport {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self { path: path.as_ref().to_path_buf(), handle: OnceLock::new() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Open once and share the handle: positional reads don't touch a cursor,
    /// so one handle serves every worker concurrently.
    fn handle(&self) -> Result<Arc<File>> {
        if let Some(f) = self.handle.get() {
            return Ok(f.clone());
        }
        let f = Arc::new(File::open(&self.path)?);
        // A lost race just means the other thread's handle wins; both are valid.
        let _ = self.handle.set(f);
        Ok(self.handle.get().expect("just set").clone())
    }
}

#[async_trait]
impl Transport for FileTransport {
    fn scheme(&self) -> &'static str {
        "file"
    }

    fn describe(&self) -> String {
        self.path.to_string_lossy().to_string()
    }

    async fn stat(&self) -> Result<SourceMeta> {
        let meta = std::fs::metadata(&self.path)?;
        Ok(SourceMeta {
            size: meta.len(),
            name: self
                .path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into()),
            content_type: None,
            supports_ranges: true,
        })
    }

    async fn read_range(&self, offset: u64, len: u32, out: &mut Vec<u8>) -> Result<()> {
        if len == 0 {
            out.clear();
            return Ok(());
        }
        let file = self.handle()?;
        // Hand the caller's allocation to the blocking pool and take it back,
        // so pooled buffers survive the round trip.
        let mut buf = std::mem::take(out);
        let result = tokio::task::spawn_blocking(move || {
            buf.clear();
            buf.resize(len as usize, 0);
            match posio::pread_exact(&file, &mut buf, offset) {
                Ok(()) => Ok(buf),
                Err(e) => Err((e, buf)),
            }
        })
        .await
        .map_err(|e| EngineError::other(format!("blocking read panicked: {e}")))?;

        match result {
            Ok(buf) => {
                *out = buf;
                Ok(())
            }
            Err((e, buf)) => {
                *out = buf;
                out.clear();
                Err(EngineError::Io(e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, data: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prev-filetransport-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, data).unwrap();
        p
    }

    #[tokio::test]
    async fn stats_and_reads_arbitrary_ranges() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let path = temp_file("clip.mkv", &data);
        let t = FileTransport::new(&path);

        let meta = t.stat().await.unwrap();
        assert_eq!(meta.size, 1000);
        assert_eq!(meta.name, "clip.mkv");
        assert!(meta.supports_ranges);

        let mut buf = Vec::new();
        t.read_range(500, 100, &mut buf).await.unwrap();
        assert_eq!(buf, &data[500..600]);

        // Reading past the end must fail rather than return a short buffer.
        assert!(t.read_range(950, 100, &mut buf).await.is_err());
    }

    #[tokio::test]
    async fn concurrent_reads_share_one_handle() {
        let data: Vec<u8> = (0..8192u32).map(|i| (i % 251) as u8).collect();
        let path = temp_file("concurrent.bin", &data);
        let t = Arc::new(FileTransport::new(&path));

        let mut tasks = Vec::new();
        for i in 0..8u64 {
            let t = t.clone();
            tasks.push(tokio::spawn(async move {
                let mut buf = Vec::new();
                t.read_range(i * 1024, 1024, &mut buf).await.unwrap();
                (i, buf)
            }));
        }
        for task in tasks {
            let (i, buf) = task.await.unwrap();
            let start = (i * 1024) as usize;
            assert_eq!(buf, &data[start..start + 1024], "worker {i} read the wrong range");
        }
    }

    #[tokio::test]
    async fn missing_file_is_an_error_not_a_panic() {
        let t = FileTransport::new("this/path/does/not/exist.mkv");
        assert!(t.stat().await.is_err());
        let mut buf = Vec::new();
        assert!(t.read_range(0, 10, &mut buf).await.is_err());
    }
}
