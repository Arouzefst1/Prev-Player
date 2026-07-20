use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

mod lan;
mod share;

struct InitialFiles(Mutex<Vec<String>>);

/// Called by the frontend on startup to retrieve any files passed via CLI args
/// (e.g. when the user double-clicks a video file associated with this app).
#[tauri::command]
fn get_initial_files(state: State<InitialFiles>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

/// Absolute path to the mpv binary bundled with the app, or None if it isn't
/// present (then the frontend falls back to mpv on PATH). Verified to exist so we
/// never hand the mpv plugin a bogus path.
#[tauri::command]
fn bundled_mpv_path(app: tauri::AppHandle) -> Option<String> {
    let p = app
        .path()
        .resolve("resources/mpv/mpv.exe", tauri::path::BaseDirectory::Resource)
        .ok()?;
    if p.exists() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Collect file paths from CLI args (from file-association double-click).
    // Skip the executable path (arg 0) and any flags.
    let initial_files: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_mpv::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(InitialFiles(Mutex::new(initial_files)))
        // Single-instance: if a second instance is opened (e.g. user opens another video
        // file, or a prevplayer:// deep-link), forward the args to the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv
                .iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .cloned()
                .collect();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                if !paths.is_empty() {
                    let _ = window.emit("open-files", paths);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Auto-updater (desktop only). The frontend drives check() / downloadAndInstall(),
    // then relaunches the app via tauri-plugin-process.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            // Register the prevplayer:// scheme at runtime so links open the app in dev
            // (the installer registers it for release builds).
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register_all();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_files,
            bundled_mpv_path,
            share::download_file,
            share::download_control,
            share::upload_github_asset,
            share::github_api,
            share::write_temp_file,
            share::share_download_dir,
            lan::lan_share_file,
            lan::lan_share_folder,
            lan::lan_stop,
            lan::lan_stop_all
        ])
        .run(tauri::generate_context!())
        .expect("error while running PREV Player");
}
