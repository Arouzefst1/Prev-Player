//! Positional file I/O — read/write at an offset without moving a shared cursor.
//!
//! This is what lets N download workers write into one `Movie.partial`
//! concurrently: each holds the same `File` handle and writes at its own chunk
//! offset, so there are no temporary chunk files and no seek races. Windows and
//! Unix spell it differently, hence this shim.

use std::fs::File;
use std::io;

#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;

/// Write the whole buffer at `offset`. Safe to call concurrently on the same
/// `File` from multiple threads as long as the ranges don't overlap.
pub fn pwrite_all(file: &File, buf: &[u8], offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        file.write_all_at(buf, offset)
    }
    #[cfg(windows)]
    {
        let mut written = 0usize;
        while written < buf.len() {
            let n = file.seek_write(&buf[written..], offset + written as u64)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "seek_write wrote 0 bytes"));
            }
            written += n;
        }
        Ok(())
    }
}

/// Fill `buf` entirely from `offset`, erroring on a short read.
pub fn pread_exact(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        file.read_exact_at(buf, offset)
    }
    #[cfg(windows)]
    {
        let mut read = 0usize;
        while read < buf.len() {
            let n = file.seek_read(&mut buf[read..], offset + read as u64)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "seek_read hit EOF"));
            }
            read += n;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn out_of_order_writes_land_at_the_right_offsets() {
        let dir = std::env::temp_dir().join(format!("prev-posio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sparse.bin");
        let f = File::options().create(true).write(true).read(true).truncate(true).open(&path).unwrap();
        f.set_len(12).unwrap();

        // Deliberately backwards, the way parallel workers would finish.
        pwrite_all(&f, b"IJKL", 8).unwrap();
        pwrite_all(&f, b"ABCD", 0).unwrap();
        pwrite_all(&f, b"EFGH", 4).unwrap();

        let mut got = String::new();
        File::open(&path).unwrap().read_to_string(&mut got).unwrap();
        assert_eq!(got, "ABCDEFGHIJKL");

        let mut mid = [0u8; 4];
        pread_exact(&f, &mut mid, 4).unwrap();
        assert_eq!(&mid, b"EFGH");

        let mut past = [0u8; 4];
        assert!(pread_exact(&f, &mut past, 10).is_err(), "reading past EOF must fail");

        drop(f);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
