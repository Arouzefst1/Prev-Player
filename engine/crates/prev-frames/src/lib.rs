//! Still frames and probes, from a headless mpv.
//!
//! The library used to make its thumbnails and read durations with the
//! WebView's `<video>` element, which can't open MKV, most HEVC, DTS, TrueHD —
//! exactly the high-end files this player exists for — so those showed a blank
//! card and no length. The player already ships mpv, which opens everything, so
//! a second mpv with no window and no sound does this job instead.
//!
//! It runs as a separate process the app talks to over mpv's JSON IPC (a named
//! pipe on Windows, a Unix socket elsewhere), never through the playing
//! instance: a thumbnail must not disturb what is on screen. There are two
//! lanes, each its own mpv, so a library scan never makes a seek-bar preview
//! wait behind it. A lane starts on first use and keeps its file open, so a
//! run of previews of the same video costs one seek each.
//!
//! HDR frames are tone-mapped to SDR on the way out (FFmpeg's zscale +
//! tonemap). Without it a PQ frame's code values land in a JPEG as if they
//! were SDR, and the thumbnail comes out flat and washed out.

mod ipc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use ipc::Ipc;

/// Thumbnails are this wide (height follows the aspect). Big enough for a
/// library card and a seek-bar preview on a 4K screen, small enough to keep a
/// thousand of them in IndexedDB.
pub const THUMB_WIDTH: u32 = 480;

/// How long one open/seek may take before the lane is restarted. A healthy 4K
/// HEVC keyframe decodes in well under a second even in software; this only
/// catches a file that wedges the demuxer.
const DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lane {
    /// Library scans: one file after another.
    Library,
    /// Seek-bar previews for the video that is playing.
    Preview,
}

/// What a probe learns about a file. Raw mpv values — the app's media.ts turns
/// them into words, so there is one place that knows how.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub duration: Option<f64>,
    /// `video-params` (static fields only).
    pub video_params: Option<Value>,
    /// `track-list`, as mpv reports it.
    pub track_list: Value,
    /// `data:image/jpeg;base64,…`, or None for audio without cover art.
    pub thumbnail: Option<String>,
}

/// Distinguishes engines within one process (the app has one; tests have many).
static INSTANCE: AtomicU64 = AtomicU64::new(0);

pub struct FrameEngine {
    mpv: PathBuf,
    library: Mutex<Option<Worker>>,
    preview: Mutex<Option<Worker>>,
    temp: PathBuf,
}

impl FrameEngine {
    /// `mpv` is the binary to run (the bundled mpv.exe, or just "mpv" to use PATH).
    pub fn new(mpv: impl Into<PathBuf>) -> Self {
        let n = INSTANCE.fetch_add(1, Ordering::Relaxed);
        let temp = std::env::temp_dir().join(format!("prevplayer-frames-{}-{n}", std::process::id()));
        Self { mpv: mpv.into(), library: Mutex::new(None), preview: Mutex::new(None), temp }
    }

    fn lane(&self, lane: Lane) -> &Mutex<Option<Worker>> {
        match lane {
            Lane::Library => &self.library,
            Lane::Preview => &self.preview,
        }
    }

    /// Run `f` on a lane's worker, starting it if needed. A worker that fails
    /// is thrown away, so the next call gets a fresh mpv.
    fn with<T>(&self, lane: Lane, f: impl FnOnce(&mut Worker) -> Result<T, String>) -> Result<T, String> {
        let mut slot = self.lane(lane).lock().unwrap();
        if slot.is_none() {
            *slot = Some(Worker::start(&self.mpv, lane, &self.temp)?);
        }
        let result = f(slot.as_mut().unwrap());
        if result.is_err() {
            if let Some(w) = slot.take() {
                w.stop();
            }
        }
        result
    }

    /// Duration, tracks, picture format and a thumbnail from ~10% in.
    pub fn probe(&self, path: &str) -> Result<Probe, String> {
        self.with(Lane::Library, |w| {
            w.open(path)?;
            let duration = w.get("duration").as_f64();
            let track_list = w.get("track-list");
            let video_params = w.video_params();
            let at = match duration {
                // Past cold opens and studio logos, but not so far a short clip ends.
                Some(d) if d > 20.0 => d * 0.1,
                Some(d) if d > 2.0 => d * 0.3,
                _ => 0.0,
            };
            let thumbnail = if w.has_video() { w.grab(at)? } else { None };
            Ok(Probe { duration, video_params, track_list, thumbnail })
        })
    }

    /// A frame of `path` at `at` seconds (the nearest keyframe before it).
    pub fn frame(&self, lane: Lane, path: &str, at: f64) -> Result<Option<String>, String> {
        self.with(lane, |w| {
            w.open(path)?;
            if !w.has_video() {
                return Ok(None);
            }
            w.grab(at)
        })
    }

    /// Close the lane's mpv — when the player leaves a file, or a scan ends.
    pub fn release(&self, lane: Lane) {
        if let Some(w) = self.lane(lane).lock().unwrap().take() {
            w.stop();
        }
    }

    pub fn shutdown(&self) {
        self.release(Lane::Library);
        self.release(Lane::Preview);
        let _ = std::fs::remove_dir_all(&self.temp);
    }
}

impl Drop for FrameEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// One headless mpv
// ---------------------------------------------------------------------------

/// Frame scaled before anything else, so a 4K frame never goes through the
/// colour conversion at full size.
fn sdr_chain() -> String {
    format!("lavfi=[scale={THUMB_WIDTH}:-2]")
}

/// PQ / HLG → linear → BT.709 primaries → Hable tone curve → SDR BT.709.
fn hdr_chain() -> String {
    format!(
        "lavfi=[scale={THUMB_WIDTH}:-2,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,\
         tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p]"
    )
}

struct Worker {
    ipc: Ipc,
    child: Arc<Mutex<std::process::Child>>,
    /// Bumped per operation; the watchdog only kills an operation still running.
    op: Arc<AtomicU64>,
    loaded: Option<String>,
    shot: PathBuf,
}

impl Worker {
    fn start(mpv: &PathBuf, lane: Lane, temp: &PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(temp).map_err(|e| e.to_string())?;
        // Unique per engine and lane: the temp folder already is, so take its name.
        let base = temp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let name = format!("{base}-{lane:?}").to_lowercase();
        let endpoint = ipc::endpoint(&name, temp);
        let mut cmd = std::process::Command::new(mpv);
        cmd.args([
            "--no-config",
            "--idle=yes",
            "--force-window=no",
            "--vo=null",
            "--ao=null",
            "--pause",
            // A preview is "around here", so the nearest keyframe is the right
            // answer and costs one decode instead of a run of them.
            "--hr-seek=no",
            // Hardware decoding where it exists, copied back so the filters can
            // read the frame.
            "--hwdec=auto-copy-safe",
            "--sid=no",
            "--load-scripts=no",
            "--ytdl=no",
            "--screenshot-format=jpg",
            "--screenshot-jpeg-quality=82",
            "--msg-level=all=error",
        ]);
        cmd.arg(format!("--input-ipc-server={endpoint}"));
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().map_err(|e| format!("couldn't start mpv for thumbnails: {e}"))?;
        #[cfg(windows)]
        die_with_us(&child);
        let child = Arc::new(Mutex::new(child));
        let ipc = match Ipc::connect(&endpoint, Duration::from_secs(10)) {
            Ok(ipc) => ipc,
            Err(e) => {
                let _ = child.lock().unwrap().kill();
                return Err(e);
            }
        };
        Ok(Self { ipc, child, op: Arc::new(AtomicU64::new(0)), loaded: None, shot: temp.join(format!("{name}.jpg")) })
    }

    /// Kill mpv if this operation is still running at the deadline, which
    /// unblocks the read waiting on it.
    fn watchdog(&self) -> u64 {
        let id = self.op.fetch_add(1, Ordering::SeqCst) + 1;
        let (op, child) = (self.op.clone(), self.child.clone());
        std::thread::spawn(move || {
            std::thread::sleep(DEADLINE);
            if op.load(Ordering::SeqCst) == id {
                let _ = child.lock().unwrap().kill();
            }
        });
        id
    }

    fn done(&self) {
        self.op.fetch_add(1, Ordering::SeqCst);
    }

    fn get(&mut self, prop: &str) -> Value {
        self.ipc.command(&["get_property".into(), prop.into()]).unwrap_or(Value::Null)
    }

    fn has_video(&mut self) -> bool {
        self.get("video-params/w").as_f64().unwrap_or(0.0) > 0.0
    }

    fn video_params(&mut self) -> Option<Value> {
        let v = self.get("video-params");
        let obj = v.as_object()?;
        // Static fields only: the dynamic HDR10+ / Dolby Vision ones change per
        // frame and mean nothing for a file at rest.
        let keep = ["w", "h", "pixelformat", "gamma", "primaries", "colormatrix", "max-cll", "max-fall", "max-luma"];
        Some(Value::Object(obj.iter().filter(|(k, _)| keep.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()))
    }

    /// Open `path` (once), wait for its first frame, and set the filter chain
    /// its picture needs.
    fn open(&mut self, path: &str) -> Result<(), String> {
        if self.loaded.as_deref() == Some(path) {
            return Ok(());
        }
        self.loaded = None;
        self.watchdog();
        let result = (|| -> Result<(), String> {
            self.ipc.command(&["set_property".into(), "vf".into(), "".into()])?;
            self.ipc.drain_events();
            self.ipc.command(&["loadfile".into(), path.into()])?;
            self.ipc.wait_event("playback-restart", Instant::now() + DEADLINE)?;
            let gamma = self.get("video-params/gamma");
            let chain = match gamma.as_str() {
                Some("pq") | Some("hlg") => hdr_chain(),
                _ => sdr_chain(),
            };
            self.ipc.command(&["set_property".into(), "vf".into(), chain.into()])?;
            Ok(())
        })();
        self.done();
        result?;
        self.loaded = Some(path.to_string());
        Ok(())
    }

    /// The frame at the keyframe at or before `at`, as a JPEG data URL.
    fn grab(&mut self, at: f64) -> Result<Option<String>, String> {
        self.watchdog();
        let result = (|| -> Result<Option<String>, String> {
            self.ipc.drain_events();
            self.ipc.command(&["seek".into(), at.max(0.0).into(), "absolute+keyframes".into()])?;
            self.ipc.wait_event("playback-restart", Instant::now() + DEADLINE)?;
            let _ = std::fs::remove_file(&self.shot);
            let shot = self.shot.to_string_lossy().to_string();
            if self.ipc.command(&["screenshot-to-file".into(), shot.into(), "video".into()]).is_err() {
                return Ok(None); // no picture to take (audio-only)
            }
            let bytes = std::fs::read(&self.shot).map_err(|e| format!("thumbnail not written: {e}"))?;
            let _ = std::fs::remove_file(&self.shot);
            Ok(Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))))
        })();
        self.done();
        result
    }

    fn stop(self) {
        let _ = self.ipc.send_quit();
        let mut child = self.child.lock().unwrap();
        // Give it a moment to exit on its own, then make sure.
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Put a child in a job that kills everything in it when this process exits,
/// however it exits. Windows doesn't end child processes with their parent, so
/// after a crash an idle mpv would otherwise stay running in the background.
#[cfg(windows)]
fn die_with_us(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // One job for the process, never closed: its handle closing at exit is
    // what kills the children. Kept as an integer, since a raw handle isn't Sync.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    });
    if job != 0 {
        unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) };
    }
}

#[cfg(test)]
mod tests;
