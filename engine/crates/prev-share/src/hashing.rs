//! Lazy whole-file hashing for the sender.
//!
//! Hashing a 40 GB file the moment it is shared would burn minutes of disk I/O
//! for a share nobody may ever download. Instead the sender hashes on demand:
//! the first `/h/<id>` request starts a background pass, the endpoint answers
//! `202 Accepted` until it finishes, and the receiver picks the hash up when it
//! reaches the end of its download.

use prev_core::Sha256Stream;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HashState {
    NotStarted,
    Running,
    Done(String),
    Failed(String),
}

#[derive(Default)]
pub struct LazyHash {
    state: Mutex<Option<HashState>>,
}

impl LazyHash {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn peek(&self) -> HashState {
        self.state.lock().unwrap().clone().unwrap_or(HashState::NotStarted)
    }

    /// Return the current state, kicking off the computation if this is the
    /// first ask. Never blocks the caller on the actual hashing.
    pub fn get_or_start(self: &Arc<Self>, path: PathBuf) -> HashState {
        {
            let mut guard = self.state.lock().unwrap();
            match guard.clone().unwrap_or(HashState::NotStarted) {
                HashState::NotStarted => *guard = Some(HashState::Running),
                other => return other,
            }
        }
        let this = self.clone();
        std::thread::spawn(move || {
            let result = hash_file(&path);
            let mut guard = this.state.lock().unwrap();
            *guard = Some(match result {
                Ok(h) => HashState::Done(h),
                Err(e) => HashState::Failed(e),
            });
        });
        HashState::Running
    }

    /// Test/CLI helper: hash synchronously and cache the result.
    pub fn compute_blocking(self: &Arc<Self>, path: PathBuf) -> HashState {
        let state = match hash_file(&path) {
            Ok(h) => HashState::Done(h),
            Err(e) => HashState::Failed(e),
        };
        *self.state.lock().unwrap() = Some(state.clone());
        state
    }
}

fn hash_file(path: &PathBuf) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut stream = Sha256Stream::new();
    // 1 MB at a time: large enough to keep the disk busy, small enough that a
    // background hash of a huge file never shows up as a memory spike.
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        stream.update(&buf[..n]);
    }
    Ok(stream.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_once_and_caches() {
        let dir = std::env::temp_dir().join(format!("prev-lazyhash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.bin");
        std::fs::write(&path, b"abc").unwrap();

        let h = LazyHash::new();
        assert_eq!(h.peek(), HashState::NotStarted);
        assert_eq!(h.get_or_start(path.clone()), HashState::Running);

        // Wait for the background pass.
        for _ in 0..200 {
            if let HashState::Done(_) = h.peek() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            h.peek(),
            HashState::Done("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_failure_for_a_missing_file() {
        let h = LazyHash::new();
        assert!(matches!(
            h.compute_blocking(PathBuf::from("nope/does/not/exist")),
            HashState::Failed(_)
        ));
    }
}
