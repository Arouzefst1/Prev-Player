//! The ephemeral share server.
//!
//! Registered shares live in memory only. There is no persistence, no upload
//! and no copy: a request maps an opaque id to a path and streams that file's
//! bytes off disk. Ids are derived from a hash rather than a counter so a link
//! can't be guessed by a neighbour on the same Wi-Fi.

use crate::hashing::{HashState, LazyHash};
use crate::{content_type, require_local_ip};
use prev_core::{parse_range, sha256_hex, EngineError, RangeReq, Result, ShareFile, ShareLink};
use std::collections::HashMap;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Request, Response, StatusCode};

/// How many request threads the server runs. Media streaming holds a connection
/// open for the whole response, so a handful of threads is the difference
/// between "one receiver at a time" and "a household".
const DEFAULT_THREADS: usize = 8;

struct FileEntry {
    name: String,
    path: PathBuf,
    hash: Arc<LazyHash>,
}

enum Entry {
    File(FileEntry),
    Folder { name: String, files: Vec<FileEntry> },
}

struct Inner {
    http: Arc<tiny_http::Server>,
    port: u16,
    host: String,
    shares: Mutex<HashMap<String, Entry>>,
    running: AtomicBool,
    counter: AtomicU64,
}

/// A handle to the running server. Cheap to clone; call [`ShareServer::shutdown`]
/// to stop serving (closing the app has the same effect).
#[derive(Clone)]
pub struct ShareServer(Arc<Inner>);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveShare {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub url: String,
    pub size: u64,
    pub file_count: usize,
}

impl ShareServer {
    /// Bind on all interfaces on an ephemeral port and start serving.
    pub fn start() -> Result<Self> {
        Self::start_with(None, None, DEFAULT_THREADS)
    }

    /// Bind to 127.0.0.1 only — used by tests and by anything that shouldn't be
    /// reachable from the network.
    pub fn start_local() -> Result<Self> {
        Self::start_with(Some("127.0.0.1:0"), Some("127.0.0.1".into()), 4)
    }

    /// `bind` defaults to `0.0.0.0:0`; `advertise_host` defaults to the detected
    /// LAN IP and is what ends up inside share links.
    pub fn start_with(bind: Option<&str>, advertise_host: Option<String>, threads: usize) -> Result<Self> {
        let bind = bind.unwrap_or("0.0.0.0:0");
        let http = tiny_http::Server::http(bind)
            .map_err(|e| EngineError::Other(format!("could not start share server: {e}")))?;
        let port = http
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| EngineError::Other("share server has no port".into()))?;
        let host = match advertise_host {
            Some(h) => h,
            None => require_local_ip()?,
        };

        let inner = Arc::new(Inner {
            http: Arc::new(http),
            port,
            host,
            shares: Mutex::new(HashMap::new()),
            running: AtomicBool::new(true),
            counter: AtomicU64::new(0),
        });

        for _ in 0..threads.max(1) {
            let inner = inner.clone();
            std::thread::spawn(move || {
                while inner.running.load(Ordering::Relaxed) {
                    match inner.http.recv() {
                        Ok(req) => handle(&inner, req),
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(Self(inner))
    }

    pub fn port(&self) -> u16 {
        self.0.port
    }

    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.0.host, self.0.port)
    }

    /// Publish a single file. Returns the link to hand to the receiver.
    pub fn share_file(&self, path: impl AsRef<Path>) -> Result<ShareLink> {
        let path = path.as_ref().to_path_buf();
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(EngineError::Other(format!("{} is not a file", path.display())));
        }
        let name = file_name(&path);
        let id = self.next_id(&name);
        let base = self.base_url();

        self.0.shares.lock().unwrap().insert(
            id.clone(),
            Entry::File(FileEntry { name: name.clone(), path, hash: LazyHash::new() }),
        );

        let mut link = ShareLink::file("lan", format!("{base}/s/{id}"), name, meta.len());
        link.hash_url = Some(format!("{base}/h/{id}"));
        Ok(link)
    }

    /// Publish a set of files as one folder share.
    pub fn share_folder(&self, paths: &[PathBuf], folder_name: &str) -> Result<ShareLink> {
        if paths.is_empty() {
            return Err(EngineError::Other("a folder share needs at least one file".into()));
        }
        let mut files = Vec::with_capacity(paths.len());
        let mut share_files = Vec::with_capacity(paths.len());
        let id = self.next_id(folder_name);
        let base = self.base_url();

        for (i, p) in paths.iter().enumerate() {
            let meta = std::fs::metadata(p)?;
            if !meta.is_file() {
                continue;
            }
            let name = file_name(p);
            share_files.push(ShareFile {
                name: name.clone(),
                size: meta.len(),
                url: format!("{base}/f/{id}/{i}"),
                sha256: None,
                hash_url: Some(format!("{base}/h/{id}/{i}")),
            });
            files.push(FileEntry { name, path: p.clone(), hash: LazyHash::new() });
        }
        if files.is_empty() {
            return Err(EngineError::Other("none of those paths are readable files".into()));
        }

        self.0
            .shares
            .lock()
            .unwrap()
            .insert(id.clone(), Entry::Folder { name: folder_name.to_string(), files });

        Ok(ShareLink::folder("lan", format!("{base}/f/{id}"), folder_name, share_files))
    }

    /// Revoke a share. The link stops resolving immediately, mid-transfer.
    pub fn stop(&self, id: &str) -> bool {
        self.0.shares.lock().unwrap().remove(id).is_some()
    }

    pub fn stop_all(&self) {
        self.0.shares.lock().unwrap().clear();
    }

    pub fn active(&self) -> Vec<ActiveShare> {
        let base = self.base_url();
        self.0
            .shares
            .lock()
            .unwrap()
            .iter()
            .map(|(id, e)| match e {
                Entry::File(f) => ActiveShare {
                    id: id.clone(),
                    name: f.name.clone(),
                    kind: "file",
                    url: format!("{base}/s/{id}"),
                    size: std::fs::metadata(&f.path).map(|m| m.len()).unwrap_or(0),
                    file_count: 1,
                },
                Entry::Folder { name, files } => ActiveShare {
                    id: id.clone(),
                    name: name.clone(),
                    kind: "folder",
                    url: format!("{base}/f/{id}"),
                    size: files
                        .iter()
                        .map(|f| std::fs::metadata(&f.path).map(|m| m.len()).unwrap_or(0))
                        .sum(),
                    file_count: files.len(),
                },
            })
            .collect()
    }

    pub fn shutdown(&self) {
        self.0.running.store(false, Ordering::Relaxed);
        self.stop_all();
        self.0.http.unblock();
    }

    /// Opaque, non-sequential id. A wall-clock counter alone would let anyone on
    /// the LAN enumerate active shares.
    fn next_id(&self, seed: &str) -> String {
        let n = self.0.counter.fetch_add(1, Ordering::Relaxed);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let material = format!("{t}:{n}:{}:{seed}:{:p}", self.0.port, self as *const _);
        sha256_hex(material.as_bytes())[..16].to_string()
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

fn handle(inner: &Inner, req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match segs.as_slice() {
        [] | ["health"] => respond_text(req, 200, "ok"),
        ["s", id] => serve_entry_file(inner, req, id, None),
        ["f", id] => serve_manifest(inner, req, id),
        ["f", id, idx] => serve_entry_file(inner, req, id, Some(idx)),
        ["h", id] => serve_hash(inner, req, id, None),
        ["h", id, idx] => serve_hash(inner, req, id, Some(idx)),
        _ => respond_text(req, 404, "not found"),
    }
}

/// Resolve `(id, optional index)` to a concrete file entry.
fn lookup(inner: &Inner, id: &str, idx: Option<&str>) -> Option<(PathBuf, String, Arc<LazyHash>)> {
    let shares = inner.shares.lock().unwrap();
    let entry = shares.get(id)?;
    match (entry, idx) {
        (Entry::File(f), None) => Some((f.path.clone(), f.name.clone(), f.hash.clone())),
        (Entry::Folder { files, .. }, Some(i)) => {
            let f = files.get(i.parse::<usize>().ok()?)?;
            Some((f.path.clone(), f.name.clone(), f.hash.clone()))
        }
        _ => None,
    }
}

fn serve_manifest(inner: &Inner, req: Request, id: &str) {
    let body = {
        let shares = inner.shares.lock().unwrap();
        match shares.get(id) {
            Some(Entry::Folder { name, files }) => {
                let items: Vec<_> = files
                    .iter()
                    .enumerate()
                    .map(|(i, f)| {
                        serde_json::json!({
                            "index": i,
                            "name": f.name,
                            "size": std::fs::metadata(&f.path).map(|m| m.len()).unwrap_or(0),
                        })
                    })
                    .collect();
                Some(serde_json::json!({ "folder": name, "items": items }).to_string())
            }
            _ => None,
        }
    };
    match body {
        Some(b) => {
            let resp = Response::from_string(b)
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
            let _ = req.respond(resp);
        }
        None => respond_text(req, 404, "no such folder share"),
    }
}

fn serve_hash(inner: &Inner, req: Request, id: &str, idx: Option<&str>) {
    let Some((path, _, lazy)) = lookup(inner, id, idx) else {
        respond_text(req, 404, "no such share");
        return;
    };
    match lazy.get_or_start(path) {
        HashState::Done(h) => {
            let resp = Response::from_string(serde_json::json!({ "sha256": h }).to_string())
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
            let _ = req.respond(resp);
        }
        // 202: "ask again shortly" — the receiver polls while finishing up.
        HashState::NotStarted | HashState::Running => respond_text(req, 202, "hashing"),
        HashState::Failed(e) => respond_text(req, 500, &e),
    }
}

fn serve_entry_file(inner: &Inner, req: Request, id: &str, idx: Option<&str>) {
    let Some((path, name, _)) = lookup(inner, id, idx) else {
        respond_text(req, 404, "no such share");
        return;
    };

    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            respond_text(req, 404, "file is no longer available");
            return;
        }
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ct = content_type(&name);
    // HEAD needs no special case: tiny_http writes the headers and skips the
    // body itself, so a HEAD gets correct Content-Length/Content-Range for free.
    //
    // `with_chunked_threshold(usize::MAX)` below is load-bearing. tiny_http
    // switches to `Transfer-Encoding: chunked` for any body over 32 KB, and a
    // chunked response carries no length — so ffmpeg's `avio_size()` fails,
    // every seek is refused, and an MKV won't play at all because it cannot
    // reach its cues. Media responses must always send Content-Length.

    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| parse_range(h.value.as_str(), total))
        .unwrap_or(RangeReq::Full);

    match range {
        RangeReq::Unsatisfiable => {
            let resp = Response::from_string("range not satisfiable")
                .with_status_code(416)
                .with_header(Header::from_bytes("Content-Range", format!("bytes */{total}")).unwrap());
            let _ = req.respond(resp);
        }
        RangeReq::Bytes(start, end) => {
            let len = end - start + 1;
            if file.seek(SeekFrom::Start(start)).is_err() {
                respond_text(req, 500, "seek failed");
                return;
            }
            let reader = std::io::Read::take(file, len);
            let mut resp = Response::new(StatusCode(206), vec![], reader, Some(len as usize), None)
                .with_chunked_threshold(usize::MAX);
            add(&mut resp, "Content-Type", ct);
            add(&mut resp, "Accept-Ranges", "bytes");
            add(&mut resp, "Content-Range", &format!("bytes {start}-{end}/{total}"));
            let _ = req.respond(resp);
        }
        RangeReq::Full => {
            let mut resp = Response::new(StatusCode(200), vec![], file, Some(total as usize), None)
                .with_chunked_threshold(usize::MAX);
            add(&mut resp, "Content-Type", ct);
            add(&mut resp, "Accept-Ranges", "bytes");
            let _ = req.respond(resp);
        }
    }
}

fn add<R: std::io::Read>(resp: &mut Response<R>, field: &str, value: &str) {
    if let Ok(h) = Header::from_bytes(field.as_bytes(), value.as_bytes()) {
        let _ = resp.add_header(h);
    }
}

fn respond_text(req: Request, status: u16, body: &str) {
    let _ = req.respond(Response::from_string(body).with_status_code(status));
}

#[cfg(test)]
mod tests {
    use super::*;
    use prev_core::ShareKind;
    use prev_transport::{fetch_manifest, HttpTransport, Transport};

    fn workdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("prev-share-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, name: &str, len: usize) -> (PathBuf, Vec<u8>) {
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let p = dir.join(name);
        std::fs::write(&p, &data).unwrap();
        (p, data)
    }

    /// Regression: tiny_http chunks any body over 32 KB by default, and a
    /// chunked response has no Content-Length. Players derive the file size
    /// from that header; without it ffmpeg's `avio_size()` returns ENOSYS,
    /// seeking is refused, and an MKV fails to load entirely.
    #[test]
    fn large_media_responses_carry_content_length_and_are_never_chunked() {
        let dir = workdir("chunked");
        // Comfortably over tiny_http's 32 KB threshold.
        let (path, data) = write(&dir, "Big.mkv", 400_000);
        let server = ShareServer::start_local().unwrap();
        let link = server.share_file(&path).unwrap();

        for (label, extra) in [
            ("full body", ""),
            ("open-ended range", "Range: bytes=0-\r\n"),
            ("mid-file range", "Range: bytes=100000-399999\r\n"),
        ] {
            let (status, headers) = raw_head_of(&link.url, extra);
            let lower = headers.to_lowercase();
            assert!(
                lower.contains("content-length:"),
                "{label}: media response must state its length, got status {status}:\n{headers}"
            );
            assert!(
                !lower.contains("transfer-encoding: chunked"),
                "{label}: chunked encoding hides the size and breaks seeking:\n{headers}"
            );
        }

        // And the advertised length must be the truth.
        let (_, headers) = raw_head_of(&link.url, "Range: bytes=0-\r\n");
        let len: usize = headers
            .to_lowercase()
            .lines()
            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
            .unwrap();
        assert_eq!(len, data.len());

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shares_a_file_and_serves_arbitrary_ranges() {
        let dir = workdir("file");
        let (path, data) = write(&dir, "Movie.mkv", 40_000);
        let server = ShareServer::start_local().unwrap();
        let link = server.share_file(&path).unwrap();

        assert_eq!(link.kind, ShareKind::File);
        assert_eq!(link.name, "Movie.mkv");
        assert_eq!(link.size, 40_000);
        assert!(link.hash_url.is_some());

        let t = HttpTransport::new(&link.url).unwrap();
        let meta = t.stat().await.unwrap();
        assert_eq!(meta.size, 40_000);
        assert!(meta.supports_ranges, "seeking must work or streaming can't");
        assert_eq!(meta.content_type.as_deref(), Some("video/x-matroska"));

        let mut buf = Vec::new();
        t.read_range(10_000, 4096, &mut buf).await.unwrap();
        assert_eq!(buf, &data[10_000..14_096]);
        // Tail read, the case that catches off-by-one range maths.
        t.read_range(39_990, 10, &mut buf).await.unwrap();
        assert_eq!(buf, &data[39_990..]);

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn folder_share_publishes_a_manifest_and_per_file_urls() {
        let dir = workdir("folder");
        let (a, da) = write(&dir, "E01.mkv", 5_000);
        let (b, _) = write(&dir, "E02.mkv", 7_000);
        let server = ShareServer::start_local().unwrap();
        let link = server.share_folder(&[a, b], "Season 1").unwrap();

        assert_eq!(link.kind, ShareKind::Folder);
        assert_eq!(link.size, 12_000);

        let manifest = fetch_manifest(&link.url).await.unwrap();
        assert_eq!(manifest.folder, "Season 1");
        assert_eq!(manifest.items.len(), 2);
        assert_eq!(manifest.items[0].size, 5_000);
        assert_eq!(manifest.total_size(), 12_000);

        let files = link.files.clone().unwrap();
        let t = HttpTransport::new(&files[0].url).unwrap();
        let mut buf = Vec::new();
        t.read_range(0, 100, &mut buf).await.unwrap();
        assert_eq!(buf, &da[..100]);

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stopping_a_share_kills_the_link_immediately() {
        let dir = workdir("revoke");
        let (path, _) = write(&dir, "secret.mkv", 1_000);
        let server = ShareServer::start_local().unwrap();
        let link = server.share_file(&path).unwrap();
        let t = HttpTransport::new(&link.url).unwrap();
        assert!(t.stat().await.is_ok());

        assert_eq!(server.active().len(), 1);
        let id = server.active()[0].id.clone();
        assert!(server.stop(&id));

        assert!(t.stat().await.is_err(), "a revoked link must stop resolving");
        assert!(server.active().is_empty());

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn hash_endpoint_answers_202_then_the_digest() {
        let dir = workdir("hash");
        let (path, data) = write(&dir, "v.mkv", 3_000);
        let server = ShareServer::start_local().unwrap();
        let link = server.share_file(&path).unwrap();
        let hash_url = link.hash_url.clone().unwrap();

        let client = reqwest_blocking_get(&hash_url);
        assert!(client.0 == 202 || client.0 == 200, "first ask starts the hash");

        let mut digest = None;
        for _ in 0..100 {
            let (status, body) = reqwest_blocking_get(&hash_url);
            if status == 200 {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap();
                digest = Some(v["sha256"].as_str().unwrap().to_string());
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(digest.as_deref(), Some(prev_core::sha256_hex(&data).as_str()));

        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn share_ids_are_not_guessable_from_each_other() {
        let dir = workdir("ids");
        let (path, _) = write(&dir, "a.mkv", 10);
        let server = ShareServer::start_local().unwrap();
        let ids: Vec<String> = (0..8)
            .map(|_| {
                let l = server.share_file(&path).unwrap();
                l.url.rsplit('/').next().unwrap().to_string()
            })
            .collect();
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 8);
        for id in &ids {
            assert_eq!(id.len(), 16);
            // Consecutive ids must not share a prefix, which a timestamp would.
            assert!(!ids.iter().any(|o| o != id && o[..8] == id[..8]));
        }
        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Send a GET with optional extra headers and return `(status, headers)`
    /// without reading the body — so a 223 MB response costs nothing.
    fn raw_head_of(url: &str, extra_headers: &str) -> (u16, String) {
        use std::io::{Read as _, Write as _};
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n{extra_headers}\r\n").unwrap();

        let mut raw = Vec::new();
        let mut byte = [0u8; 1];
        // Read to the end of the header block only.
        while raw.len() < 8192 {
            match s.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => raw.push(byte[0]),
            }
            if raw.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let headers = String::from_utf8_lossy(&raw).to_string();
        let status = headers
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        (status, headers)
    }

    /// Tiny blocking GET so this test doesn't need an async client.
    fn reqwest_blocking_get(url: &str) -> (u16, String) {
        use std::io::{Read as _, Write as _};
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = String::new();
        s.read_to_string(&mut raw).unwrap();
        let status = raw
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }
}
