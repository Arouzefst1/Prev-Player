// ===========================================================================
// Thumbnails, durations and format probes for any file mpv can open — library
// cards and seek-bar previews. The work lives in the engine (prev-frames); this
// file only hands it the bundled mpv and moves the calls off the UI thread.
// ===========================================================================

use prev_frames::{FrameEngine, Lane, Probe, Storyboard};
use tauri::{AppHandle, Manager, State};

pub struct FramesState(pub FrameEngine);

/// Same mpv as the player: the bundled one, else whatever is on PATH (dev).
pub fn init(app: &AppHandle) {
    let mpv = crate::mpv_binary(app).unwrap_or_else(|| "mpv".into());
    app.manage(FramesState(FrameEngine::new(mpv)));
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<FramesState>() {
        state.0.shutdown();
    }
}

fn lane(name: &str) -> Lane {
    if name == "library" { Lane::Library } else { Lane::Preview }
}

/// Run on a blocking thread with the engine borrowed from Tauri's state.
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&FrameEngine) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<FramesState>().0))
        .await
        .map_err(|e| format!("frame task failed: {e}"))?
}

#[tauri::command]
pub async fn frames_probe(app: AppHandle, path: String) -> Result<Probe, String> {
    blocking(app, move |e| e.probe(&path)).await
}

/// A JPEG data URL of the frame at `at` seconds — the keyframe before it,
/// or with `exact` that very frame — or null for audio.
#[tauri::command]
pub async fn frames_grab(app: AppHandle, path: String, at: f64, lane_name: String, exact: Option<bool>) -> Result<Option<String>, String> {
    blocking(app, move |e| e.frame(lane(&lane_name), &path, at, exact.unwrap_or(false))).await
}

/// A frame for every second of `path`, for seek-bar previews — or null when
/// the file is too big to decode end to end (previews then come from
/// `frames_grab`).
#[tauri::command]
pub async fn frames_storyboard(app: AppHandle, path: String) -> Result<Option<Storyboard>, String> {
    blocking(app, move |e| e.storyboard(&path)).await
}

#[tauri::command]
pub async fn frames_release(state: State<'_, FramesState>, lane_name: String) -> Result<(), String> {
    state.0.release(lane(&lane_name));
    Ok(())
}
