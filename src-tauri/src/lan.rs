// ===========================================================================
// LAN sharing — an ephemeral, storage-free transport.
//
// A tiny local HTTP server streams the shared file(s) directly from disk (with
// HTTP range support so the receiver can seek). NOTHING is uploaded or stored in
// the cloud: the file is only reachable while the app is running and the share is
// registered. Stop the share (or close the app) and the link is dead.
//
// Only works when both devices are on the same network (same Wi-Fi/LAN).
// ===========================================================================

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tiny_http::{Header, Response, Server, StatusCode};

struct Entry {
    file: Option<PathBuf>,           // single-file share
    folder_name: String,             // folder share display name
    files: Vec<(String, PathBuf)>,   // folder share: (name, path)
}

static SHARES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
static PORT: OnceLock<u16> = OnceLock::new();

fn shares() -> &'static Mutex<HashMap<String, Entry>> {
    SHARES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", n & 0xff_ffff_ffff)
}

/// Best-effort local IP on the active network (the address other devices dial).
fn local_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?; // no packets sent; just picks the route
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "flv" => "video/x-flv",
        "ts" => "video/mp2t",
        "mpg" | "mpeg" => "video/mpeg",
        "ogv" | "ogg" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        _ => "application/octet-stream",
    }
}

fn ensure_server() -> Result<u16, String> {
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }
    let server = Server::http("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("could not read server port")?;
    let _ = PORT.set(port);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            handle(req);
        }
    });
    Ok(port)
}

fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes=")?;
    let mut it = rest.splitn(2, '-');
    let start: u64 = it.next()?.trim().parse().ok()?;
    let end = it.next().unwrap_or("").trim();
    let end = if end.is_empty() { None } else { end.parse::<u64>().ok() };
    Some((start, end))
}

fn handle(req: tiny_http::Request) {
    let url = req.url().to_string();
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str()));

    let parts: Vec<String> = url
        .split('?')
        .next()
        .unwrap_or("")
        .trim_start_matches('/')
        .split('/')
        .map(|s| s.to_string())
        .collect();
    let parts: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();

    let path: Option<PathBuf> = match parts.as_slice() {
        ["s", id] => shares().lock().unwrap().get(*id).and_then(|e| e.file.clone()),
        ["f", id] => {
            // Folder manifest (JSON list of files + sizes).
            let g = shares().lock().unwrap();
            if let Some(e) = g.get(*id) {
                let items: Vec<_> = e
                    .files
                    .iter()
                    .enumerate()
                    .map(|(i, (n, p))| {
                        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                        serde_json::json!({ "index": i, "name": n, "size": size })
                    })
                    .collect();
                let body = serde_json::json!({ "folder": e.folder_name, "items": items }).to_string();
                let _ = req.respond(
                    Response::from_string(body)
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
                );
            } else {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
            }
            return;
        }
        ["f", id, idx] => shares().lock().unwrap().get(*id).and_then(|e| {
            idx.parse::<usize>().ok().and_then(|i| e.files.get(i).map(|(_, p)| p.clone()))
        }),
        _ => None,
    };

    match path {
        Some(p) => serve_file(req, &p, range),
        None => {
            let _ = req.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}

fn serve_file(req: tiny_http::Request, path: &PathBuf, range: Option<(u64, Option<u64>)>) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            let _ = req.respond(Response::from_string("not found").with_status_code(404));
            return;
        }
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ct = content_type(path.file_name().and_then(|n| n.to_str()).unwrap_or(""));

    match range {
        Some((start, end)) => {
            let end = end.unwrap_or(total.saturating_sub(1)).min(total.saturating_sub(1));
            if start > end || start >= total {
                let _ = req.respond(Response::from_string("range not satisfiable").with_status_code(416));
                return;
            }
            let len = end - start + 1;
            let _ = file.seek(SeekFrom::Start(start));
            let reader = file.take(len);
            let mut resp = Response::new(StatusCode(206), vec![], reader, Some(len as usize), None);
            let _ = resp.add_header(Header::from_bytes("Content-Type", ct).unwrap());
            let _ = resp.add_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
            let _ = resp.add_header(
                Header::from_bytes("Content-Range", format!("bytes {}-{}/{}", start, end, total)).unwrap(),
            );
            let _ = req.respond(resp);
        }
        None => {
            let mut resp = Response::new(StatusCode(200), vec![], file, Some(total as usize), None);
            let _ = resp.add_header(Header::from_bytes("Content-Type", ct).unwrap());
            let _ = resp.add_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
            let _ = req.respond(resp);
        }
    }
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn lan_share_file(path: String) -> Result<serde_json::Value, String> {
    let port = ensure_server()?;
    let ip = local_ip().ok_or("Could not detect your local network IP.")?;
    let name = PathBuf::from(&path)
        .file_name().and_then(|n| n.to_str()).unwrap_or("video").to_string();
    let id = rid();
    shares().lock().unwrap().insert(
        id.clone(),
        Entry { file: Some(PathBuf::from(&path)), folder_name: String::new(), files: vec![] },
    );
    Ok(serde_json::json!({ "id": id, "url": format!("http://{}:{}/s/{}", ip, port, id), "name": name }))
}

#[tauri::command]
pub fn lan_share_folder(paths: Vec<String>, folder_name: String) -> Result<serde_json::Value, String> {
    let port = ensure_server()?;
    let ip = local_ip().ok_or("Could not detect your local network IP.")?;
    let files: Vec<(String, PathBuf)> = paths
        .iter()
        .map(|p| {
            let name = PathBuf::from(p).file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
            (name, PathBuf::from(p))
        })
        .collect();
    let count = files.len();
    let id = rid();
    shares().lock().unwrap().insert(
        id.clone(),
        Entry { file: None, folder_name: folder_name.clone(), files },
    );
    Ok(serde_json::json!({ "id": id, "url": format!("http://{}:{}/f/{}", ip, port, id), "name": folder_name, "count": count }))
}

#[tauri::command]
pub fn lan_stop(id: String) {
    shares().lock().unwrap().remove(&id);
}

#[tauri::command]
pub fn lan_stop_all() {
    shares().lock().unwrap().clear();
}
