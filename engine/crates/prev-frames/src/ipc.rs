//! mpv's JSON IPC: one JSON object per line each way. Commands carry a
//! `request_id` and get a reply with the same id; events (`playback-restart`,
//! `end-file`, …) arrive in between, unasked, and are kept until waited for.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

/// Where mpv listens: a named pipe on Windows, a socket file elsewhere.
pub fn endpoint(name: &str, temp: &Path) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\{name}")
    } else {
        temp.join(format!("{name}.sock")).to_string_lossy().to_string()
    }
}

pub struct Ipc {
    reader: BufReader<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    next_id: u64,
    events: VecDeque<Value>,
}

impl Ipc {
    /// Connect, retrying while mpv is still starting up and hasn't made the
    /// endpoint yet.
    pub fn connect(endpoint: &str, within: Duration) -> Result<Self, String> {
        let deadline = Instant::now() + within;
        loop {
            match open(endpoint) {
                Ok((r, w)) => {
                    return Ok(Self { reader: BufReader::new(r), writer: w, next_id: 0, events: VecDeque::new() })
                }
                Err(e) if Instant::now() >= deadline => return Err(format!("mpv never opened its IPC endpoint: {e}")),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line).map_err(|e| format!("mpv stopped answering: {e}"))?;
            if n == 0 {
                return Err("mpv exited".into());
            }
            if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                return Ok(v);
            }
        }
    }

    /// Run a command and return its `data`. An mpv error ("property
    /// unavailable", a failed screenshot) comes back as Err.
    pub fn command(&mut self, args: &[Value]) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({ "command": args, "request_id": id });
        writeln!(self.writer, "{msg}").map_err(|e| format!("mpv stopped listening: {e}"))?;
        self.writer.flush().map_err(|e| e.to_string())?;
        loop {
            let m = self.read_message()?;
            if m.get("request_id").and_then(Value::as_u64) == Some(id) {
                return match m.get("error").and_then(Value::as_str) {
                    Some("success") => Ok(m.get("data").cloned().unwrap_or(Value::Null)),
                    Some(e) => Err(e.to_string()),
                    None => Err("malformed reply".into()),
                };
            }
            if m.get("event").is_some() {
                self.events.push_back(m);
            }
        }
    }

    /// Forget events that have already happened, before starting something
    /// whose own event we're about to wait for.
    pub fn drain_events(&mut self) {
        self.events.clear();
    }

    /// Wait for `name`. A file that fails to open ends with `end-file` instead,
    /// which is reported as the error it is.
    pub fn wait_event(&mut self, name: &str, deadline: Instant) -> Result<(), String> {
        loop {
            while let Some(e) = self.events.pop_front() {
                match e.get("event").and_then(Value::as_str) {
                    Some(n) if n == name => return Ok(()),
                    Some("end-file") if e.get("reason").and_then(Value::as_str) == Some("error") => {
                        let why = e.get("file_error").and_then(Value::as_str).unwrap_or("unreadable");
                        return Err(format!("mpv couldn't open the file ({why})"));
                    }
                    _ => {}
                }
            }
            if Instant::now() >= deadline {
                return Err(format!("timed out waiting for {name}"));
            }
            // Blocks until mpv says something; the worker's watchdog kills mpv
            // (ending this read) if that never happens.
            let m = self.read_message()?;
            if m.get("event").is_some() {
                self.events.push_back(m);
            }
        }
    }

    pub fn send_quit(mut self) -> Result<(), String> {
        writeln!(self.writer, "{}", json!({ "command": ["quit"] })).map_err(|e| e.to_string())?;
        self.writer.flush().map_err(|e| e.to_string())
    }
}

#[cfg(unix)]
fn open(endpoint: &str) -> std::io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let s = std::os::unix::net::UnixStream::connect(endpoint)?;
    Ok((Box::new(s.try_clone()?), Box::new(s)))
}

#[cfg(windows)]
fn open(endpoint: &str) -> std::io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    // A named pipe opens like a file. Reads and writes never overlap here (one
    // command, then its reply), so plain synchronous handles are enough.
    let f = std::fs::OpenOptions::new().read(true).write(true).open(endpoint)?;
    Ok((Box::new(f.try_clone()?), Box::new(f)))
}
