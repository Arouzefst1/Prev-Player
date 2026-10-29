// ===========================================================================
// Updates, done quietly.
//
// The Tauri updater plugin does the signed check and the download; this module
// owns WHEN things happen and HOW the installer runs, because the two must
// differ:
//
//   * A small update (patch bump such as 1.5.1 -> 1.5.2, or `"silent": true`
//     in latest.json) is downloaded in the background and installed the moment
//     the user closes the app — silently and WITHOUT relaunching. Nobody clicks
//     anything and nothing restarts in front of them; the next launch is simply
//     the new version.
//   * "Update now" (the dialog, or the toast shown for a bigger release)
//     installs silently and relaunches, since the user asked for it right then.
//
// On Windows the NSIS installer restarts the app only when it sees `/R`, and
// the plugin can't vary that per call: its install mode is global config. So
// `installMode` is `basicUi` (no flags of its own) and every check here adds
// the flags it wants — `/S` for silent, plus `/R` when a relaunch is wanted.
// NSIS honours `/S` wherever it sits on the command line; verified with a
// throwaway installer, because the plugin puts extra args after `/UPDATE /ARGS`.
//
// Two `Update` handles are kept per release because the flags are baked in at
// check time. The bytes are downloaded once and verified against the manifest
// signature by the plugin, and stay in memory (~40 MB) so installing at exit
// still works if the network is gone by then.
// ===========================================================================

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    /// Install without telling anyone: a patch release, or flagged in latest.json.
    pub quiet: bool,
    /// The package is in memory and can be installed right away.
    pub downloaded: bool,
}

struct Pending {
    info: UpdateInfo,
    bytes: Vec<u8>,
    /// `/S /R`: silent, relaunch afterwards ("update now").
    relaunch: Update,
    /// `/S`: silent, stays closed (installing as the app exits).
    stay_closed: Update,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Option<Pending>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// "Small" means the user wouldn't want to be told: same major.minor. A
/// `"silent": true|false` field in latest.json overrides the guess either way.
fn is_quiet(update: &Update) -> bool {
    if let Some(flag) = update.raw_json.get("silent").and_then(|v| v.as_bool()) {
        return flag;
    }
    same_major_minor(&update.current_version, &update.version)
}

fn same_major_minor(a: &str, b: &str) -> bool {
    fn major_minor(v: &str) -> (String, String) {
        let mut parts = v.trim().trim_start_matches('v').split('.');
        let major = parts.next().unwrap_or("").to_string();
        let minor = parts.next().unwrap_or("").to_string();
        (major, minor)
    }
    major_minor(a) == major_minor(b)
}

async fn check_with_flags(app: &AppHandle, flags: &[&str]) -> Result<Option<Update>, String> {
    app.updater_builder()
        .clear_installer_args()
        .installer_args(flags.iter().copied())
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Is a newer signed release published? With `download`, fetch it as well —
/// once: a release already in memory is not downloaded again — reporting
/// progress on the `update-progress` event.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
    download: bool,
) -> Result<Option<UpdateInfo>, String> {
    let Some(relaunch) = check_with_flags(&app, &["/S", "/R"]).await? else {
        return Ok(None);
    };
    let mut info = UpdateInfo {
        version: relaunch.version.clone(),
        current_version: relaunch.current_version.clone(),
        notes: relaunch.body.clone(),
        quiet: is_quiet(&relaunch),
        downloaded: false,
    };

    // Already have this one? Then it's ready, whatever was asked for.
    if let Some(p) = state.0.lock().unwrap().as_ref() {
        if p.info.version == info.version {
            return Ok(Some(p.info.clone()));
        }
    }
    if !download {
        return Ok(Some(info));
    }

    let Some(stay_closed) = check_with_flags(&app, &["/S"]).await? else {
        return Ok(None); // pulled between the two checks: nothing to install
    };
    if stay_closed.version != info.version {
        return Err("the release changed while checking; try again".into());
    }

    let mut downloaded = 0u64;
    let bytes = relaunch
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    info.downloaded = true;
    *state.0.lock().unwrap() = Some(Pending {
        info: info.clone(),
        bytes,
        relaunch,
        stay_closed,
    });
    Ok(Some(info))
}

/// The release waiting in memory, if any.
#[tauri::command]
pub fn update_pending(state: State<'_, UpdateState>) -> Option<UpdateInfo> {
    state.0.lock().unwrap().as_ref().map(|p| p.info.clone())
}

/// Run the downloaded installer. On Windows this launches it and EXITS THE
/// PROCESS, so on success it never returns. `relaunch` decides whether the app
/// comes back afterwards: yes for "update now", no when installing on close.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    relaunch: bool,
) -> Result<(), String> {
    let pending = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("no update has been downloaded")?;
    // The run loop's exit handler won't get a turn: stop transfers cleanly here.
    crate::engine::shutdown(&app);
    crate::frames::shutdown(&app);
    crate::display::restore_all();
    let update = if relaunch { &pending.relaunch } else { &pending.stay_closed };
    update.install(&pending.bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::same_major_minor;

    #[test]
    fn a_patch_bump_is_small_and_anything_bigger_is_not() {
        assert!(same_major_minor("1.5.1", "1.5.2"));
        assert!(same_major_minor("v1.5.1", "1.5.10"));
        assert!(!same_major_minor("1.5.2", "1.6.0"));
        assert!(!same_major_minor("1.5.2", "2.0.0"));
    }
}
