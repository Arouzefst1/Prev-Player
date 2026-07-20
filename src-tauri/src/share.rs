// ===========================================================================
// Sharing backend — GitHub Release assets as a free, lifetime, CDN-streamed store.
//
// Rust owns the heavy transfers (streaming download WITH progress, and streaming
// upload so large files don't blow up memory) plus a thin GitHub REST passthrough
// (avoids WebView CORS quirks). The frontend orchestrates the flow + UI.
// ===========================================================================

use futures_util::StreamExt;
use std::io::Write;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
struct Progress {
    id: String,
    transferred: u64,
    total: u64,
    done: bool,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("PREV-Player")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Stream-download a URL to `dest`, emitting `share-progress` events keyed by `id`.
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    url: String,
    dest: String,
    id: String,
) -> Result<(), String> {
    let resp = client().get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    // Ensure parent dir exists.
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut transferred: u64 = 0;
    let mut last = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        transferred += chunk.len() as u64;
        if last.elapsed().as_millis() > 120 {
            last = std::time::Instant::now();
            let _ = app.emit(
                "share-progress",
                Progress {
                    id: id.clone(),
                    transferred,
                    total,
                    done: false,
                },
            );
        }
    }
    let _ = file.flush();
    let _ = app.emit(
        "share-progress",
        Progress {
            id,
            transferred,
            total,
            done: true,
        },
    );
    Ok(())
}

/// Stream-upload a local file to a GitHub release asset upload URL (already
/// containing `?name=`). Returns the created asset JSON (has `browser_download_url`).
#[tauri::command]
pub async fn upload_github_asset(
    upload_url: String,
    token: String,
    file_path: String,
    content_type: String,
) -> Result<String, String> {
    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    let len = file.metadata().await.map_err(|e| e.to_string())?.len();
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = reqwest::Body::wrap_stream(stream);

    let resp = client()
        .post(&upload_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", content_type)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(reqwest::header::CONTENT_LENGTH, len)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Upload failed: HTTP {} — {}", status, text));
    }
    Ok(text)
}

/// Write `content` to a uniquely-named temp file and return its path (used for
/// the folder-share manifest). Writing in Rust avoids fs-plugin scope config.
#[tauri::command]
pub fn write_temp_file(content: String, ext: String) -> Result<String, String> {
    let mut path = std::env::temp_dir();
    let name = format!(
        "prev-{}.{}",
        uuid_like(),
        if ext.is_empty() { "tmp".into() } else { ext }
    );
    path.push(name);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}

/// Suggest a downloads directory for received shares and ensure it exists.
#[tauri::command]
pub fn share_download_dir() -> Result<String, String> {
    let base = dirs_download().ok_or_else(|| "no downloads dir".to_string())?;
    let dir = base.join("PREV Player");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

fn dirs_download() -> Option<std::path::PathBuf> {
    // %USERPROFILE%\Downloads on Windows; fall back to home.
    if let Ok(up) = std::env::var("USERPROFILE") {
        let d = std::path::Path::new(&up).join("Downloads");
        if d.exists() {
            return Some(d);
        }
        return Some(std::path::PathBuf::from(up));
    }
    std::env::var("HOME").ok().map(std::path::PathBuf::from)
}

#[derive(serde::Serialize)]
pub struct HttpResp {
    status: u16,
    body: String,
}

/// Thin GitHub REST passthrough (create repo/release, fetch release by tag, list
/// assets, etc.). `token` is optional — omit for public read-only calls.
#[tauri::command]
pub async fn github_api(
    method: String,
    url: String,
    token: Option<String>,
    body: Option<String>,
) -> Result<HttpResp, String> {
    let c = client();
    let mut req = match method.to_uppercase().as_str() {
        "GET" => c.get(&url),
        "POST" => c.post(&url),
        "PATCH" => c.patch(&url),
        "PUT" => c.put(&url),
        "DELETE" => c.delete(&url),
        other => return Err(format!("unsupported method: {other}")),
    };
    req = req
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {}", t));
    }
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok(HttpResp { status, body: text })
}
