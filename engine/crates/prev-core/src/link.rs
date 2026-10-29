//! Self-contained share links.
//!
//! A link carries everything a receiver needs to resolve the share without any
//! server lookup: which transport to use, where to dial, the media name/size,
//! and the chunk grid the sender used. That is what makes the system
//! infrastructure-free — the link *is* the metadata service.
//!
//! Wire format: `prev://<base64url(json)>`. Keys are single letters because the
//! link gets pasted into chat apps; a folder share of 40 files still fits well
//! inside a message.

use crate::chunk::ChunkPlan;
use crate::error::EngineError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

pub const SCHEME: &str = "prev://";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareKind {
    File,
    Folder,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareFile {
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "z")]
    pub size: u64,
    #[serde(rename = "u")]
    pub url: String,
    #[serde(rename = "h", skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
    #[serde(rename = "hu", skip_serializing_if = "Option::is_none", default)]
    pub hash_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareLink {
    /// Format version, so old clients can refuse a link they can't parse.
    #[serde(rename = "v")]
    pub version: u8,
    #[serde(rename = "k")]
    pub kind: ShareKind,
    /// Transport id: `lan`, `http`, `file`, and whatever plugs in later.
    #[serde(rename = "t")]
    pub transport: String,
    /// Where to fetch bytes (single file) or the manifest (folder).
    #[serde(rename = "u")]
    pub url: String,
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "z", default)]
    pub size: u64,
    #[serde(rename = "c", default)]
    pub chunk_size: u32,
    #[serde(rename = "h", skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
    /// Where to ask the sender for the whole-file SHA-256 once the transfer is
    /// done. Optional because not every transport can serve one (a GitHub
    /// asset, for instance, publishes its hash in the link instead).
    #[serde(rename = "hu", skip_serializing_if = "Option::is_none", default)]
    pub hash_url: Option<String>,
    #[serde(rename = "f", skip_serializing_if = "Option::is_none", default)]
    pub files: Option<Vec<ShareFile>>,
    /// Other addresses a LAN sender answers on, besides the one in `url`. A PC
    /// on Wi-Fi and Ethernet at once, or with a VPN or virtual adapter, has
    /// several and can't tell which network the receiver is on — so it lists
    /// them all, and the receiver dials whichever answers. Older apps ignore it.
    #[serde(rename = "a", skip_serializing_if = "Option::is_none", default)]
    pub alt_hosts: Option<Vec<String>>,
}

impl ShareLink {
    pub fn file(transport: &str, url: impl Into<String>, name: impl Into<String>, size: u64) -> Self {
        let plan = ChunkPlan::auto(size);
        Self {
            version: 1,
            kind: ShareKind::File,
            transport: transport.to_string(),
            url: url.into(),
            name: name.into(),
            size,
            chunk_size: plan.chunk_size,
            sha256: None,
            hash_url: None,
            files: None,
            alt_hosts: None,
        }
    }

    pub fn folder(
        transport: &str,
        url: impl Into<String>,
        name: impl Into<String>,
        files: Vec<ShareFile>,
    ) -> Self {
        let size = files.iter().map(|f| f.size).sum();
        Self {
            version: 1,
            kind: ShareKind::Folder,
            transport: transport.to_string(),
            url: url.into(),
            name: name.into(),
            size,
            chunk_size: ChunkPlan::auto(size).chunk_size,
            sha256: None,
            hash_url: None,
            files: Some(files),
            alt_hosts: None,
        }
    }

    /// Every host this share can be dialled at: the one in `url`, then the
    /// alternatives the sender listed.
    pub fn hosts(&self) -> Vec<String> {
        let mut all: Vec<String> = url_host(&self.url).map(str::to_string).into_iter().collect();
        for h in self.alt_hosts.iter().flatten() {
            if !all.contains(h) {
                all.push(h.clone());
            }
        }
        all
    }

    /// The same share reached through `host`: every URL it carries — the
    /// source, the digest, each folder entry — points there, port and path kept.
    pub fn with_host(&self, host: &str) -> ShareLink {
        let mut link = self.clone();
        link.url = replace_host(&link.url, host);
        link.hash_url = link.hash_url.map(|u| replace_host(&u, host));
        for f in link.files.iter_mut().flatten() {
            f.url = replace_host(&f.url, host);
            f.hash_url = f.hash_url.take().map(|u| replace_host(&u, host));
        }
        link.alt_hosts = None;
        link
    }

    /// The chunk grid the sender committed to. A resumed transfer must keep it.
    pub fn plan(&self) -> ChunkPlan {
        if self.chunk_size == 0 {
            ChunkPlan::auto(self.size)
        } else {
            ChunkPlan::new(self.size, self.chunk_size)
        }
    }

    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("ShareLink is always serialisable");
        format!("{}{}", SCHEME, URL_SAFE_NO_PAD.encode(json))
    }

    /// Parse a `prev://` link. A bare `http(s)://` URL is also accepted and
    /// treated as an unresolved single-file HTTP share — size and chunk grid
    /// get filled in by a `stat` call once a transport is built.
    pub fn decode(input: &str) -> Result<Self, EngineError> {
        let s: String = input.trim().split_whitespace().collect();
        if let Some(rest) = s.strip_prefix(SCHEME) {
            let bytes = URL_SAFE_NO_PAD
                .decode(rest.trim_end_matches('/'))
                .map_err(|e| EngineError::Link(format!("not valid base64url: {e}")))?;
            let link: ShareLink = serde_json::from_slice(&bytes)
                .map_err(|e| EngineError::Link(format!("payload is not a share link: {e}")))?;
            if link.version != 1 {
                return Err(EngineError::Link(format!(
                    "link format v{} is newer than this app understands",
                    link.version
                )));
            }
            if link.url.is_empty() {
                return Err(EngineError::Link("link has no source url".into()));
            }
            return Ok(link);
        }
        if s.starts_with("http://") || s.starts_with("https://") {
            let name = s
                .rsplit('/')
                .next()
                .filter(|n| !n.is_empty())
                .unwrap_or("download")
                .split('?')
                .next()
                .unwrap_or("download")
                .to_string();
            return Ok(Self::file("http", s.clone(), name, 0));
        }
        Err(EngineError::Link("expected a prev:// or http(s):// link".into()))
    }
}

/// The host of an `http(s)://host[:port]/…` URL, without port or brackets.
pub fn url_host(url: &str) -> Option<&str> {
    let authority = url.split_once("://")?.1.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map(|(_, a)| a).unwrap_or(authority);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split_once(']')?.0
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then_some(host)
}

/// `url` with its host swapped for `host`; scheme, port and path untouched.
fn replace_host(url: &str, host: &str) -> String {
    let Some(old) = url_host(url) else { return url.to_string() };
    let Some(at) = url.find(old) else { return url.to_string() };
    format!("{}{}{}", &url[..at], host, &url[at + old.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_moves_to_another_host_with_every_url_it_carries() {
        let files = vec![ShareFile {
            name: "a.mkv".into(),
            size: 1,
            url: "http://10.5.0.2:4123/f/x/0".into(),
            sha256: None,
            hash_url: Some("http://10.5.0.2:4123/h/x/0".into()),
        }];
        let mut link = ShareLink::folder("lan", "http://10.5.0.2:4123/f/x", "S1", files);
        link.alt_hosts = Some(vec!["192.168.1.23".into(), "10.5.0.2".into()]);
        assert_eq!(link.hosts(), ["10.5.0.2", "192.168.1.23"], "primary first, no repeats");

        let moved = link.with_host("192.168.1.23");
        assert_eq!(moved.url, "http://192.168.1.23:4123/f/x");
        let f = &moved.files.as_ref().unwrap()[0];
        assert_eq!(f.url, "http://192.168.1.23:4123/f/x/0");
        assert_eq!(f.hash_url.as_deref(), Some("http://192.168.1.23:4123/h/x/0"));
        assert_eq!(moved.alt_hosts, None, "a chosen address is final");
    }

    #[test]
    fn old_links_without_alternatives_still_decode_and_new_ones_roundtrip() {
        let mut link = ShareLink::file("lan", "http://192.168.1.5:7421/s/ab12", "Movie.mkv", 10);
        // Exactly what an app from before alternatives encoded.
        let old = link.encode();
        assert_eq!(ShareLink::decode(&old).unwrap().alt_hosts, None);

        link.alt_hosts = Some(vec!["10.0.0.7".into()]);
        assert_eq!(ShareLink::decode(&link.encode()).unwrap(), link);
    }

    #[test]
    fn url_host_handles_ports_paths_and_ipv6() {
        assert_eq!(url_host("http://192.168.1.5:7421/s/ab"), Some("192.168.1.5"));
        assert_eq!(url_host("https://github.com/a/b"), Some("github.com"));
        assert_eq!(url_host("http://[fe80::1]:80/x"), Some("fe80::1"));
        assert_eq!(url_host("http://h"), Some("h"));
        assert_eq!(url_host("not a url"), None);
    }

    #[test]
    fn file_link_roundtrips() {
        let mut link = ShareLink::file("lan", "http://192.168.1.5:7421/s/ab12", "Movie.mkv", 42_000_000_000);
        link.sha256 = Some("deadbeef".into());
        let encoded = link.encode();
        assert!(encoded.starts_with(SCHEME));
        assert_eq!(ShareLink::decode(&encoded).unwrap(), link);
    }

    #[test]
    fn folder_link_roundtrips_and_sums_sizes() {
        let files = vec![
            ShareFile { name: "a.mkv".into(), size: 100, url: "http://h/f/x/0".into(), sha256: None, hash_url: None },
            ShareFile { name: "b.mkv".into(), size: 250, url: "http://h/f/x/1".into(), sha256: None, hash_url: None },
        ];
        let link = ShareLink::folder("lan", "http://h/f/x", "Season 1", files);
        assert_eq!(link.size, 350);
        let decoded = ShareLink::decode(&link.encode()).unwrap();
        assert_eq!(decoded.kind, ShareKind::Folder);
        assert_eq!(decoded.files.unwrap().len(), 2);
    }

    #[test]
    fn survives_being_pasted_with_stray_whitespace() {
        // Chat apps wrap long links; the decoder must stitch them back together.
        let link = ShareLink::file("lan", "http://h/s/1", "v.mp4", 10);
        let encoded = link.encode();
        let (a, b) = encoded.split_at(encoded.len() / 2);
        assert_eq!(ShareLink::decode(&format!("  {a}\n{b} ")).unwrap(), link);
    }

    #[test]
    fn bare_http_url_is_accepted_as_a_share() {
        let l = ShareLink::decode("https://example.com/files/Movie.mkv?token=1").unwrap();
        assert_eq!(l.transport, "http");
        assert_eq!(l.name, "Movie.mkv");
        assert_eq!(l.size, 0, "size stays unknown until stat()");
    }

    #[test]
    fn rejects_garbage() {
        assert!(ShareLink::decode("hello world").is_err());
        assert!(ShareLink::decode("prev://!!!not-base64!!!").is_err());
        assert!(ShareLink::decode(&format!("{SCHEME}{}", URL_SAFE_NO_PAD.encode(b"{}"))).is_err());
    }

    #[test]
    fn plan_matches_the_size_recorded_in_the_link() {
        let link = ShareLink::file("lan", "http://h/s/1", "big.mkv", 40 * 1024 * 1024 * 1024);
        let plan = link.plan();
        assert_eq!(plan.total, 40 * 1024 * 1024 * 1024);
        assert_eq!(plan.chunk_size, 16 * 1024 * 1024);
    }
}
