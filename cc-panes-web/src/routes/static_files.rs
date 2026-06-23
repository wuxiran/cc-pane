use axum::{
    http::{header, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
};
use rust_embed::Embed;
use std::borrow::Cow;
use std::path::{Path, PathBuf};

#[derive(Embed)]
#[folder = "static/"]
struct StaticAssets;

/// Serve the built React client from `dist/` when available.
/// Falls back to the embedded legacy terminal page for older standalone builds.
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let requested_path = if path.is_empty() { "index.html" } else { path };

    if let Some(response) = serve_dist_file(requested_path) {
        return response;
    }

    if is_spa_route(requested_path) {
        if let Some(response) = serve_dist_file("index.html") {
            return response;
        }
    }

    if let Some(response) = serve_embedded_file(requested_path) {
        return response;
    }

    match StaticAssets::get("index.html") {
        Some(file) => Html(String::from_utf8_lossy(&file.data).to_string()).into_response(),
        None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn serve_dist_file(path: &str) -> Option<Response> {
    for dist_root in dist_roots() {
        let Some(file_path) = safe_join(&dist_root, path) else {
            continue;
        };
        if let Ok(bytes) = std::fs::read(&file_path) {
            return Some(file_response(path, bytes));
        }
    }
    None
}

fn serve_embedded_file(path: &str) -> Option<Response> {
    let file = StaticAssets::get(path)?;
    Some(file_response(path, file.data))
}

fn file_response(path: &str, bytes: impl Into<Cow<'static, [u8]>>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache_control_for(path)),
        ],
        bytes.into().into_owned(),
    )
        .into_response()
}

/// Decide the caching policy for a served asset.
///
/// Vite emits content-hashed files under `assets/` (e.g. `assets/main.abc123.js`):
/// their name changes whenever the content does, so they can be cached forever.
/// The entry HTML and any other non-hashed root files must always be revalidated,
/// otherwise a browser keeps serving a stale `index.html` after an app upgrade and
/// loads the previous build.
fn cache_control_for(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn dist_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("CCPANES_WEB_DIST_DIR").map(PathBuf::from) {
        roots.push(path);
    }
    roots.push(PathBuf::from("dist"));
    roots.push(PathBuf::from("resources").join("web-dist"));

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.join("dist"));
            roots.push(exe_dir.join("resources").join("web-dist"));
            roots.push(exe_dir.join("..").join("resources").join("web-dist"));
        }
    }

    roots
}

fn safe_join(root: &Path, request_path: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(request_path).components() {
        match component {
            std::path::Component::Normal(segment) => path.push(segment),
            _ => return None,
        }
    }
    Some(path)
}

fn is_spa_route(path: &str) -> bool {
    !path.starts_with("api/") && !path.starts_with("ws/") && !path.contains('.')
}
