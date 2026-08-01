//! The local playback endpoint.
//!
//! mpv (or any player) opens `http://127.0.0.1:<port>/stream/<id>` and treats
//! it as a normal seekable file. Every read is answered from the session's
//! rolling buffer, fetching on demand — so seeking in the player is just a
//! `Range` request, and the buffer re-targets itself around the new position.
//!
//! Bound to loopback only: this endpoint exposes the *receiver's* buffer, and
//! nothing outside the machine has any business reading it.

use crate::session::StreamSession;
use prev_core::{parse_range, EngineError, RangeReq, Result};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Request, Response, StatusCode};

/// Threads serving playback. A player opens a fresh connection on every seek and
/// abandons the previous one, so this needs headroom for the ones still winding
/// down, not just for the read that matters.
const THREADS: usize = 12;

/// Most bytes served for one request.
///
/// A player asks for `bytes=N-` — open-ended — and then abandons the response the
/// moment it seeks. Honouring that literally means one request commits a serving
/// thread to streaming the rest of the file: on a 28 GB remux the thread is still
/// dragging the reader through gigabytes long after the player stopped listening,
/// the pool starves, and later connections are refused. ffmpeg then reports
/// `avio_size() = ENOSYS`, cannot seek to the cues an MKV keeps at EOF, and gives
/// up with "File ended prematurely".
///
/// Answering with a bounded slice fixes that without losing anything: the
/// `Content-Range` still carries the true total, which is where the player learns
/// the file size, and it simply asks again when it wants more. Responses stay
/// short, so a thread is never pinned by a client that has moved on.
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

struct Inner {
    http: Arc<tiny_http::Server>,
    port: u16,
    sessions: Mutex<HashMap<String, Arc<StreamSession>>>,
    rt: tokio::runtime::Handle,
    running: AtomicBool,
}

#[derive(Clone)]
pub struct StreamServer(Arc<Inner>);

impl StreamServer {
    /// Start the endpoint. `rt` is the runtime the sessions were created on;
    /// the serving threads are plain OS threads that hand async work back to it.
    pub fn start(rt: tokio::runtime::Handle) -> Result<Self> {
        let http = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| EngineError::Other(format!("could not start stream server: {e}")))?;
        let port = http
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| EngineError::Other("stream server has no port".into()))?;

        let inner = Arc::new(Inner {
            http: Arc::new(http),
            port,
            sessions: Mutex::new(HashMap::new()),
            rt,
            running: AtomicBool::new(true),
        });

        for _ in 0..THREADS {
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

    /// Publish a session and return the URL to hand to the player.
    pub fn publish(&self, session: Arc<StreamSession>) -> String {
        let id = session.id().to_string();
        self.0.sessions.lock().unwrap().insert(id.clone(), session);
        self.url_for(&id)
    }

    pub fn url_for(&self, id: &str) -> String {
        format!("http://127.0.0.1:{}/stream/{}", self.0.port, id)
    }

    /// Stop serving a session and release its buffer.
    pub fn remove(&self, id: &str) -> Option<Arc<StreamSession>> {
        let s = self.0.sessions.lock().unwrap().remove(id);
        if let Some(s) = &s {
            s.close();
        }
        s
    }

    pub fn get(&self, id: &str) -> Option<Arc<StreamSession>> {
        self.0.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn active(&self) -> Vec<String> {
        self.0.sessions.lock().unwrap().keys().cloned().collect()
    }

    pub fn shutdown(&self) {
        self.0.running.store(false, Ordering::Relaxed);
        for (_, s) in self.0.sessions.lock().unwrap().drain() {
            s.close();
        }
        self.0.http.unblock();
    }
}

fn handle(inner: &Inner, req: Request) {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    let session = match segs.as_slice() {
        ["health"] | [] => {
            let _ = req.respond(Response::from_string("ok"));
            return;
        }
        ["stream", id] => inner.sessions.lock().unwrap().get(*id).cloned(),
        _ => None,
    };

    let Some(session) = session else {
        let _ = req.respond(Response::from_string("no such stream").with_status_code(404));
        return;
    };

    let total = session.total();
    let raw_range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let range = raw_range
        .as_deref()
        .map(|v| parse_range(v, total))
        .unwrap_or(RangeReq::Full);
    if std::env::var("PREV_TRACE_STREAM").is_ok() {
        eprintln!("[stream] <- {} Range={:?}", req.url(), raw_range);
    }

    let (status, start, mut end) = match range {
        RangeReq::Unsatisfiable => {
            let resp = Response::from_string("range not satisfiable")
                .with_status_code(416)
                .with_header(Header::from_bytes("Content-Range", format!("bytes */{total}")).unwrap());
            let _ = req.respond(resp);
            return;
        }
        RangeReq::Bytes(s, e) => (206u16, s, e),
        // No Range header at all: answer as a partial anyway, so the cap below
        // applies and the total still reaches the player via Content-Range.
        RangeReq::Full if total > MAX_RESPONSE => (206u16, 0, total - 1),
        RangeReq::Full => (200u16, 0, total.saturating_sub(1)),
    };

    // Serve at most `MAX_RESPONSE`, and only ever shrink the window the client
    // asked for — a partial response is exactly what a range request invites.
    if status == 206 && end - start + 1 > MAX_RESPONSE {
        end = start + MAX_RESPONSE - 1;
    }

    let len = end - start + 1;
    let reader = SessionReader { session: session.clone(), rt: inner.rt.clone(), pos: start, end };
    // Content-Length, never chunked: tiny_http would otherwise switch to
    // `Transfer-Encoding: chunked` above 32 KB, and a player that cannot learn
    // the file size cannot seek — which for an MKV means it cannot play at all.
    let mut resp = Response::new(StatusCode(status), vec![], reader, Some(len as usize), None)
        .with_chunked_threshold(usize::MAX);
    add(&mut resp, "Content-Type", &session.content_type());
    add(&mut resp, "Accept-Ranges", "bytes");
    if status == 206 {
        add(&mut resp, "Content-Range", &format!("bytes {start}-{end}/{total}"));
    }

    let trace = std::env::var("PREV_TRACE_STREAM").is_ok();
    let started = std::time::Instant::now();
    let outcome = req.respond(resp);
    if trace {
        eprintln!(
            "[stream] {status} {start}-{end} ({len} B) in {:?} -> {}",
            started.elapsed(),
            match &outcome { Ok(()) => "ok".into(), Err(e) => format!("ERR {e}") },
        );
    }
}

/// Bridges the player's blocking reads to the session's async buffer.
///
/// Safe to `block_on` here: these are dedicated server threads, not runtime
/// workers, so blocking one never starves the async executor.
struct SessionReader {
    session: Arc<StreamSession>,
    rt: tokio::runtime::Handle,
    pos: u64,
    end: u64,
}

impl Read for SessionReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos > self.end || buf.is_empty() {
            return Ok(0);
        }
        let want = buf.len().min((self.end - self.pos + 1) as usize);
        let session = self.session.clone();
        let pos = self.pos;
        let n = self
            .rt
            .block_on(async move { session.read_into(pos, &mut buf[..want]).await })
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        self.pos += n as u64;
        Ok(n)
    }
}

fn add<R: Read>(resp: &mut Response<R>, field: &str, value: &str) {
    if let Ok(h) = Header::from_bytes(field.as_bytes(), value.as_bytes()) {
        let _ = resp.add_header(h);
    }
}
