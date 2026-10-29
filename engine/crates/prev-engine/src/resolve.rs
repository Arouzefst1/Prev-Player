//! Turning pasted text into something the UI can show.
//!
//! A single-file link already carries its metadata, so resolving it is offline
//! and instant. A folder link points at a manifest, which is one small fetch.
//! Either way the receiver learns what it is being offered *before* committing
//! to a transfer.

use prev_core::{EngineError, Result, ShareKind, ShareLink};
use prev_transport::http::{probe, Probe, SHARE_GONE};
use prev_transport::{fetch_manifest, resolve_url};
use std::time::Duration;

/// How long one of a LAN sender's addresses gets to answer. On the same Wi-Fi
/// a reply takes milliseconds; this only bounds how long it takes to conclude
/// that none of them is reachable.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

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
    // A LAN sender lists every address it has; everything after this point
    // uses whichever one this device can actually reach.
    let link = if link.transport == "lan" { reach(link).await? } else { link };
    match link.kind {
        ShareKind::File => resolve_file(link).await,
        ShareKind::Folder => resolve_folder(link).await,
    }
}

/// Point a LAN link at an address of the sender's that answers from here.
///
/// Every address is asked at once and the first to serve the share wins, so a
/// dead one — a VPN address, a virtual switch, the other network of a PC on
/// Wi-Fi and Ethernet — costs nothing once the right one replies.
async fn reach(link: ShareLink) -> Result<ShareLink> {
    let hosts = link.hosts();
    let mut probes = tokio::task::JoinSet::new();
    for host in &hosts {
        let candidate = link.with_host(host);
        probes.spawn(async move {
            let said = probe(&candidate.url, PROBE_TIMEOUT).await;
            (candidate, said)
        });
    }
    let mut missing = false;
    while let Some(done) = probes.join_next().await {
        match done {
            Ok((candidate, Probe::Serves)) => return Ok(candidate),
            Ok((_, Probe::Missing)) => missing = true,
            _ => {}
        }
    }
    if missing {
        return Err(EngineError::Other(SHARE_GONE.into()));
    }
    Err(EngineError::Other(format!(
        "Couldn't reach the sender's PC (tried {}). Check that:\n\
         • PREV Player is still open on that PC, and still sharing\n\
         • both devices are on the same Wi-Fi — guest networks often keep devices apart\n\
         • that PC lets PREV Player through Windows Firewall: in its Share window, choose “Allow through firewall”",
        hosts.join(", ")
    )))
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
        // Not `lan`: a LAN link is probed first, to find which of the sender's
        // addresses answers. Any other folder link resolves from what it carries.
        let link = ShareLink::folder("http", "http://127.0.0.1:9/f/x", "Season 1", files);

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

    fn shared(tag: &str) -> (prev_share::ShareServer, ShareLink, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("prev-reach-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Movie.mkv");
        std::fs::write(&file, vec![7u8; 50_000]).unwrap();
        let server = prev_share::ShareServer::start_local().unwrap();
        let link = server.share_file(&file).unwrap();
        (server, link, dir)
    }

    #[tokio::test]
    async fn a_lan_link_falls_through_to_the_address_that_answers() {
        let (server, link, dir) = shared("alt");
        // The sender's best guess is dead from here (a VPN or virtual-switch
        // address, say); the working address is only among the alternatives.
        // (The server listens on 127.0.0.1 only, so 127.0.0.2 is refused.)
        let mut sent = link.with_host("127.0.0.2");
        sent.alt_hosts = Some(vec!["127.0.0.1".into()]);

        let r = resolve(&sent.encode()).await.unwrap();
        assert!(r.files[0].link.url.starts_with("http://127.0.0.1:"), "{}", r.files[0].link.url);
        assert!(
            r.files[0].link.hash_url.as_deref().unwrap().starts_with("http://127.0.0.1:"),
            "the digest must come from the same place"
        );
        assert_eq!(r.total_size, 50_000);

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_unreachable_sender_gets_advice_not_a_socket_error() {
        let link = ShareLink::file("lan", "http://127.0.0.1:9/s/x", "Movie.mkv", 10);
        let err = resolve(&link.encode()).await.unwrap_err().to_string();
        assert!(err.contains("Couldn't reach the sender"), "{err}");
        assert!(err.contains("127.0.0.1") && err.contains("Firewall"), "{err}");
    }

    #[tokio::test]
    async fn a_stopped_share_says_so() {
        let (server, link, dir) = shared("stopped");
        let id = server.active()[0].id.clone();
        server.stop(&id);
        let err = resolve(&link.encode()).await.unwrap_err().to_string();
        assert!(err.contains("isn't available any more"), "{err}");
        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn garbage_input_is_rejected_before_any_network_call() {
        assert!(resolve("not a link").await.is_err());
        assert!(resolve("").await.is_err());
    }
}
