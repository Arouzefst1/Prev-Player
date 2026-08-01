//! Turning pasted text into something the UI can show.
//!
//! A single-file link already carries its metadata, so resolving it is offline
//! and instant. A folder link points at a manifest, which is one small fetch.
//! Either way the receiver learns what it is being offered *before* committing
//! to a transfer.

use prev_core::{EngineError, Result, ShareKind, ShareLink};
use prev_transport::{fetch_manifest, resolve_url};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFile {
    pub name: String,
    pub size: u64,
    /// A complete link for this one file — downloadable or watchable on its own.
    #[serde(skip)]
    pub link: ShareLink,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedShare {
    pub name: String,
    pub kind: &'static str,
    pub total_size: u64,
    pub transport: String,
    /// One entry for a file share; one per item for a folder share.
    pub files: Vec<ResolvedFile>,
    /// True when the source honours range requests — required for both
    /// streaming and parallel download.
    pub seekable: bool,
    #[serde(skip)]
    pub link: ShareLink,
}

pub async fn resolve(input: &str) -> Result<ResolvedShare> {
    let link = ShareLink::decode(input)?;
    match link.kind {
        ShareKind::File => resolve_file(link).await,
        ShareKind::Folder => resolve_folder(link).await,
    }
}

async fn resolve_file(mut link: ShareLink) -> Result<ResolvedShare> {
    // A link pasted as a bare URL knows neither size nor name; ask the source.
    let transport = resolve_url(&link.transport, &link.url)?;
    let meta = transport.stat().await?;
    if link.size == 0 {
        link.size = meta.size;
    }
    if link.name.is_empty() {
        link.name = meta.name.clone();
    }
    if link.chunk_size == 0 {
        link.chunk_size = prev_core::ChunkPlan::auto(link.size).chunk_size;
    }

    Ok(ResolvedShare {
        name: link.name.clone(),
        kind: "file",
        total_size: link.size,
        transport: link.transport.clone(),
        seekable: meta.supports_ranges,
        files: vec![ResolvedFile { name: link.name.clone(), size: link.size, link: link.clone() }],
        link,
    })
}

async fn resolve_folder(link: ShareLink) -> Result<ResolvedShare> {
    // Prefer the file list embedded in the link; fall back to fetching the
    // manifest, which is what a link shortened to just its URL will need.
    let files = match &link.files {
        Some(f) if !f.is_empty() => f.clone(),
        _ => {
            let manifest = fetch_manifest(&link.url).await?;
            manifest.to_share_files(&link.url)
        }
    };
    if files.is_empty() {
        return Err(EngineError::Link("this folder share is empty".into()));
    }

    let resolved: Vec<ResolvedFile> = files
        .iter()
        .map(|f| {
            let mut child = ShareLink::file(&link.transport, &f.url, &f.name, f.size);
            child.sha256 = f.sha256.clone();
            child.hash_url = f.hash_url.clone();
            ResolvedFile { name: f.name.clone(), size: f.size, link: child }
        })
        .collect();

    Ok(ResolvedShare {
        name: link.name.clone(),
        kind: "folder",
        total_size: resolved.iter().map(|f| f.size).sum(),
        transport: link.transport.clone(),
        // Folder entries are served by the same server as a file share.
        seekable: true,
        files: resolved,
        link,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_folder_link_resolves_offline_from_its_embedded_file_list() {
        let files = vec![
            prev_core::ShareFile {
                name: "E01.mkv".into(),
                size: 100,
                url: "http://127.0.0.1:9/f/x/0".into(),
                sha256: None,
                hash_url: Some("http://127.0.0.1:9/h/x/0".into()),
            },
            prev_core::ShareFile {
                name: "E02.mkv".into(),
                size: 250,
                url: "http://127.0.0.1:9/f/x/1".into(),
                sha256: None,
                hash_url: None,
            },
        ];
        let link = ShareLink::folder("lan", "http://127.0.0.1:9/f/x", "Season 1", files);

        // Note the port is closed — resolving must not have touched the network.
        let r = resolve(&link.encode()).await.unwrap();
        assert_eq!(r.kind, "folder");
        assert_eq!(r.name, "Season 1");
        assert_eq!(r.total_size, 350);
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.files[1].link.url, "http://127.0.0.1:9/f/x/1");
        assert_eq!(
            r.files[0].link.hash_url.as_deref(),
            Some("http://127.0.0.1:9/h/x/0"),
            "per-file digests must survive into the child links"
        );
    }

    #[tokio::test]
    async fn garbage_input_is_rejected_before_any_network_call() {
        assert!(resolve("not a link").await.is_err());
        assert!(resolve("").await.is_err());
    }
}
