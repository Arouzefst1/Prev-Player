use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

/// Incremental SHA-256 for whole-file verification, fed chunk by chunk in
/// order so a 40 GB file is hashed without ever holding 40 GB.
#[derive(Default)]
pub struct Sha256Stream {
    inner: Sha256,
    len: u64,
}

impl Sha256Stream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.len += bytes.len() as u64;
        self.inner.update(bytes);
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn finish(self) -> String {
        hex(&self.inner.finalize())
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn streaming_equals_one_shot() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut s = Sha256Stream::new();
        for c in data.chunks(997) {
            s.update(c);
        }
        assert_eq!(s.len(), data.len() as u64);
        assert_eq!(s.finish(), sha256_hex(&data));
    }
}
