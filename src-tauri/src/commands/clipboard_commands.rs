use crate::utils::AppResult;
use tracing::debug;

#[tauri::command]
pub async fn read_clipboard_file_paths() -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(read_clipboard_file_paths_blocking)
        .await
        .map_err(|error| format!("Failed to join clipboard file path task: {}", error))?
}

fn read_clipboard_file_paths_blocking() -> AppResult<Vec<String>> {
    // File-path pasting is an optional enhancement on top of text pasting, so an
    // unusable clipboard backend must read as "no files" rather than an error.
    // On Wayland compositors without `zwlr_data_control` (GNOME/Mutter) arboard
    // fails with something other than `ClipboardNotSupported`; surfacing that as
    // `Err` made the frontend treat a normal text paste as a failed one.
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(error) => {
            debug!(
                "cmd::read_clipboard_file_paths clipboard unavailable: {}",
                error
            );
            return Ok(Vec::new());
        }
    };

    let paths = match clipboard.get().file_list() {
        Ok(paths) => paths,
        Err(error) => {
            debug!(
                "cmd::read_clipboard_file_paths file list unavailable: {}",
                error
            );
            return Ok(Vec::new());
        }
    };

    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty())
        .collect())
}
