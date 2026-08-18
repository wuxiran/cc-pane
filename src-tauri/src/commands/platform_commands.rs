#[cfg(any(target_os = "linux", test))]
fn detect_display_server(
    session_type: Option<&str>,
    wayland_display: Option<&str>,
    x11_display: Option<&str>,
) -> Option<&'static str> {
    match session_type
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wayland") => return Some("wayland"),
        Some("x11") => return Some("x11"),
        _ => {}
    }

    if wayland_display.is_some_and(|value| !value.trim().is_empty()) {
        return Some("wayland");
    }
    if x11_display.is_some_and(|value| !value.trim().is_empty()) {
        return Some("x11");
    }
    None
}

#[tauri::command]
pub fn get_display_server() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        detect_display_server(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
            std::env::var("DISPLAY").ok().as_deref(),
        )
        .map(str::to_owned)
    }

    #[cfg(not(target_os = "linux"))]
    None
}

#[cfg(test)]
mod tests {
    use super::detect_display_server;

    #[test]
    fn explicit_session_type_has_priority() {
        assert_eq!(
            detect_display_server(Some("wayland"), None, Some(":0")),
            Some("wayland")
        );
        assert_eq!(
            detect_display_server(Some(" X11 "), Some("wayland-0"), None),
            Some("x11")
        );
    }

    #[test]
    fn falls_back_to_display_environment() {
        assert_eq!(
            detect_display_server(None, Some("wayland-0"), Some(":0")),
            Some("wayland")
        );
        assert_eq!(
            detect_display_server(None, Some(""), Some(":0")),
            Some("x11")
        );
        assert_eq!(detect_display_server(None, Some(" "), Some("")), None);
    }
}
