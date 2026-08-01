//! Folder-share manifest.
//!
//! A folder share link points at a manifest instead of at bytes. The receiver
//! fetches it once, shows the file list, and then treats each entry as an
//! ordinary single-file share — so folders need no special handling anywhere
//! else in the engine.

use prev_core::{EngineError, Result, ShareFile};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestItem {
    pub index: usize,
    pub name: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderManifest {
    pub folder: String,
    pub items: Vec<ManifestItem>,
}

impl FolderManifest {
    pub fn total_size(&self) -> u64 {
        self.items.iter().map(|i| i.size).sum()
    }

    /// Turn manifest entries into share entries by appending each item's index
    /// to the manifest URL — the layout the share server serves (`/f/<id>/<n>`,
    /// with digests at the matching `/h/<id>/<n>`).
    pub fn to_share_files(&self, base_url: &str) -> Vec<ShareFile> {
        let base = base_url.trim_end_matches('/');
        let hash_base = base.rfind("/f/").map(|at| {
            let (host, rest) = base.split_at(at);
            format!("{host}/h/{}", rest.trim_start_matches("/f/"))
        });
        self.items
            .iter()
            .map(|i| ShareFile {
                name: i.name.clone(),
                size: i.size,
                url: format!("{base}/{}", i.index),
                sha256: i.sha256.clone(),
                hash_url: hash_base.as_ref().map(|h| format!("{h}/{}", i.index)),
            })
            .collect()
    }
}

pub async fn fetch_manifest(url: &str) -> Result<FolderManifest> {
    let body = reqwest::Client::builder()
        .user_agent("PREV-Player/engine")
        .build()
        .map_err(EngineError::transport)?
        .get(url)
        .send()
        .await
        .map_err(EngineError::transport)?
        .error_for_status()
        .map_err(EngineError::transport)?
        .text()
        .await
        .map_err(EngineError::transport)?;

    serde_json::from_str(&body)
        .map_err(|e| EngineError::Transport(format!("manifest is not valid: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_per_file_urls_from_the_manifest_url() {
        let m = FolderManifest {
            folder: "Season 1".into(),
            items: vec![
                ManifestItem { index: 0, name: "E01.mkv".into(), size: 100, sha256: None },
                ManifestItem { index: 1, name: "E02.mkv".into(), size: 200, sha256: Some("ab".into()) },
            ],
        };
        assert_eq!(m.total_size(), 300);
        let files = m.to_share_files("http://192.168.1.5:7421/f/abc/");
        assert_eq!(files[0].url, "http://192.168.1.5:7421/f/abc/0");
        assert_eq!(files[1].url, "http://192.168.1.5:7421/f/abc/1");
        assert_eq!(files[1].sha256.as_deref(), Some("ab"));
        assert_eq!(files[1].hash_url.as_deref(), Some("http://192.168.1.5:7421/h/abc/1"));
    }

    #[test]
    fn parses_the_wire_format() {
        let json = r#"{"folder":"S1","items":[{"index":0,"name":"a.mkv","size":5}]}"#;
        let m: FolderManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.items[0].name, "a.mkv");
        assert_eq!(m.items[0].sha256, None);
    }
}
