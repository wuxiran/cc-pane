use axum::http::{header, StatusCode, Uri};

use super::*;

fn test_dir(name: &str) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let path = std::env::temp_dir().join(format!(
        "cc-panes-web-static-{name}-{millis}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

async fn body_string(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    String::from_utf8(bytes.to_vec()).expect("utf8 body")
}

#[test]
fn safe_join_accepts_nested_normal_segments() {
    let root = Path::new("root");
    let joined = safe_join(root, "assets/app.js").expect("join nested path");
    assert_eq!(joined, root.join("assets").join("app.js"));
}

#[test]
fn safe_join_rejects_parent_dir_traversal() {
    assert!(safe_join(Path::new("root"), "../secret").is_none());
    assert!(safe_join(Path::new("root"), "assets/../../secret").is_none());
}

#[test]
fn is_spa_route_excludes_api_ws_and_file_paths() {
    assert!(is_spa_route("settings"));
    assert!(is_spa_route("workspaces/my-workspace"));
    assert!(!is_spa_route("api/sessions"));
    assert!(!is_spa_route("ws/session-1"));
    assert!(!is_spa_route("assets/app.js"));
}

#[test]
fn cache_control_marks_hashed_assets_immutable_and_html_no_cache() {
    assert_eq!(
        cache_control_for("assets/main.abc123.js"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(cache_control_for("index.html"), "no-cache");
    assert_eq!(cache_control_for("favicon.svg"), "no-cache");
}

/// All CCPANES_WEB_DIST_DIR scenarios live in a single test because the env
/// var is process-global and tests run in parallel threads.
#[tokio::test]
async fn static_handler_serves_dist_files_and_spa_fallback() {
    let dist = test_dir("dist");
    std::fs::write(dist.join("index.html"), "<html>dist index</html>").expect("write index");
    std::fs::create_dir_all(dist.join("assets")).expect("assets dir");
    std::fs::write(dist.join("assets").join("app.js"), "console.log(1)").expect("write asset");
    std::env::set_var("CCPANES_WEB_DIST_DIR", &dist);

    // Root path serves the dist index.
    let response = static_handler(Uri::from_static("/")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_string(response).await.contains("dist index"));

    // Hashed assets get the immutable cache policy and a JS content type.
    let response = static_handler(Uri::from_static("/assets/app.js")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );

    // Unknown extension-less paths fall back to the SPA index.
    let response = static_handler(Uri::from_static("/workspaces/demo")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_string(response).await.contains("dist index"));

    // API-looking paths must not receive the SPA index from dist.
    let response = static_handler(Uri::from_static("/api/unknown")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = body_string(response).await;
    assert!(!body.contains("dist index"));

    std::env::remove_var("CCPANES_WEB_DIST_DIR");
}
