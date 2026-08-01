//! The single-file sparse writer.
//!
//! There is exactly one file on disk per download: `Movie.mkv.partial`. It is
//! sized up front and workers write their chunks straight to the right offset,
//! so there are no `chunk0.bin`, `chunk1.bin`, … to create, track or clean up.
//! When the last chunk lands the file is fsynced and renamed — the finished
//! media never has to be copied.

use prev_core::{posio, EngineError, Result};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct PartialWriter {
    file: Arc<File>,
    partial: PathBuf,
    dest: PathBuf,
}

impl PartialWriter {
    /// Open (or reopen, when resuming) `<dest>.partial`, sized to `total`.
    ///
    /// Preallocating means every offset is immediately valid to write to, and a
    /// disk that is too small fails here rather than 90% into a transfer.
    pub fn open(dest: impl AsRef<Path>, total: u64) -> Result<Self> {
        let dest = dest.as_ref().to_path_buf();
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = partial_path(&dest);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&partial)?;
        if file.metadata()?.len() != total {
            file.set_len(total)?;
        }
        Ok(Self { file: Arc::new(file), partial, dest })
    }

    pub fn partial_path(&self) -> &Path {
        &self.partial
    }

    pub fn dest_path(&self) -> &Path {
        &self.dest
    }

    /// A handle other readers can use — this is how the stream engine plays
    /// back completed ranges of a download that is still in flight.
    pub fn file(&self) -> Arc<File> {
        self.file.clone()
    }

    pub fn write_chunk(&self, offset: u64, data: &[u8]) -> Result<()> {
        posio::pwrite_all(&self.file, data, offset)?;
        Ok(())
    }

    /// Write off the async runtime, handing the buffer out and back so a pooled
    /// allocation survives the trip.
    pub async fn write_chunk_owned(&self, offset: u64, buf: Vec<u8>) -> (Result<()>, Vec<u8>) {
        let file = self.file.clone();
        match tokio::task::spawn_blocking(move || {
            let r = posio::pwrite_all(&file, &buf, offset);
            (r, buf)
        })
        .await
        {
            Ok((Ok(()), buf)) => (Ok(()), buf),
            Ok((Err(e), buf)) => (Err(EngineError::Io(e)), buf),
            Err(e) => (Err(EngineError::other(format!("write task panicked: {e}"))), Vec::new()),
        }
    }

    pub fn flush(&self) -> Result<()> {
        self.file.sync_data()?;
        Ok(())
    }

    /// Commit: fsync, then rename into place. Returns the final path, which may
    /// differ from `dest` if something already occupied that name.
    pub fn finish(self) -> Result<PathBuf> {
        self.file.sync_all()?;
        drop(self.file);
        let final_path = unique_path(&self.dest);
        std::fs::rename(&self.partial, &final_path)?;
        Ok(final_path)
    }

    /// Cancel: throw the partial away. Nothing else has been written, so this
    /// is the whole cleanup.
    pub fn discard(self) -> Result<()> {
        drop(self.file);
        match std::fs::remove_file(&self.partial) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(EngineError::Io(e)),
        }
    }
}

pub fn partial_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".partial");
    PathBuf::from(s)
}

/// `Movie.mkv` → `Movie (2).mkv` when the name is taken, the way a browser
/// download would, rather than silently overwriting the user's file.
pub fn unique_path(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|s| s.to_string_lossy().to_string());
    let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    for n in 2..10_000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("prev-writer-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_chunks_out_of_order_into_one_file() {
        let dir = workdir("order");
        let dest = dir.join("Movie.mkv");
        let w = PartialWriter::open(&dest, 12).unwrap();

        assert!(w.partial_path().exists());
        assert_eq!(w.partial_path().file_name().unwrap(), "Movie.mkv.partial");
        assert_eq!(std::fs::metadata(w.partial_path()).unwrap().len(), 12, "preallocated");

        w.write_chunk(8, b"IJKL").unwrap();
        w.write_chunk(0, b"ABCD").unwrap();
        w.write_chunk(4, b"EFGH").unwrap();

        let final_path = w.finish().unwrap();
        assert_eq!(final_path, dest);
        assert_eq!(std::fs::read(&dest).unwrap(), b"ABCDEFGHIJKL");
        assert!(!partial_path(&dest).exists(), "no leftovers");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopening_keeps_already_written_bytes() {
        let dir = workdir("resume");
        let dest = dir.join("Movie.mkv");
        {
            let w = PartialWriter::open(&dest, 8).unwrap();
            w.write_chunk(0, b"ABCD").unwrap();
            w.flush().unwrap();
            // Simulate a crash: drop without finishing.
        }
        let w = PartialWriter::open(&dest, 8).unwrap();
        w.write_chunk(4, b"EFGH").unwrap();
        w.finish().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"ABCDEFGH");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let dir = workdir("collide");
        let dest = dir.join("Movie.mkv");
        std::fs::write(&dest, b"the user's own copy").unwrap();

        let w = PartialWriter::open(&dest, 4).unwrap();
        w.write_chunk(0, b"NEW!").unwrap();
        let final_path = w.finish().unwrap();

        assert_eq!(final_path.file_name().unwrap(), "Movie (2).mkv");
        assert_eq!(std::fs::read(&dest).unwrap(), b"the user's own copy");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"NEW!");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_leaves_nothing_behind() {
        let dir = workdir("discard");
        let dest = dir.join("Movie.mkv");
        let w = PartialWriter::open(&dest, 100).unwrap();
        w.write_chunk(0, b"junk").unwrap();
        let partial = w.partial_path().to_path_buf();
        w.discard().unwrap();
        assert!(!partial.exists());
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "cancel means zero disk usage");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn owned_write_returns_the_buffer_for_reuse() {
        let dir = workdir("owned");
        let dest = dir.join("Movie.mkv");
        let w = PartialWriter::open(&dest, 8).unwrap();

        let buf = b"ABCD".to_vec();
        let ptr = buf.as_ptr();
        let (res, buf) = w.write_chunk_owned(0, buf).await;
        res.unwrap();
        assert_eq!(ptr, buf.as_ptr(), "the pooled allocation must come back");

        let (res, _) = w.write_chunk_owned(4, b"EFGH".to_vec()).await;
        res.unwrap();
        w.finish().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"ABCDEFGH");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
