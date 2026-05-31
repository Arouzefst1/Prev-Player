use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct InitialFiles(Mutex<Vec<String>>);

/// Called by the frontend on startup to retrieve any files passed via CLI args
/// (e.g. when the user double-clicks a video file associated with this app).
#[tauri::command]
fn get_initial_files(state: State<InitialFiles>) -> Vec<String> {
    state.0.lock().unwrap().clone()
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
        .manage(InitialFiles(Mutex::new(initial_files)))
        // Single-instance: if a second instance is opened (e.g. user opens another video
        // file), forward the new file paths to the already-running window.
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
        .invoke_handler(tauri::generate_handler![get_initial_files])
        .run(tauri::generate_context!())
        .expect("error while running PREV Player");
}
