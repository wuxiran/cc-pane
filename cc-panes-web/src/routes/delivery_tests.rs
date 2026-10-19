use super::{build_router, workflow::workflow_tests::test_state};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};
use tower::ServiceExt;

fn git(path: &Path, args: &[&str]) {
    assert!(Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap()
        .status
        .success());
}
fn repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q"]);
    // 内容逐字节断言：Windows runner 默认 core.autocrlf=true 会改写检出换行。
    git(path, &["config", "core.autocrlf", "false"]);
    git(path, &["config", "user.name", "fixture"]);
    git(path, &["config", "user.email", "fixture@example.invalid"]);
    fs::write(path.join("a.txt"), "base\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "base"]);
}
fn post(uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}
async fn payload(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn fork_review_routes_prepare_compare_and_reject_stale_adoption() {
    let (state, root) = test_state("fork-delivery-http");
    let source = root.join("project");
    repo(&source);
    let router = build_router(state);
    let response = router
        .clone()
        .oneshot(post(
            "/api/fork-reviews/prepare",
            json!({"cwd":source,"mode":"worktree","sourceSessionId":"source"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let prepared = payload(response).await;
    let id = prepared["record"]["id"].as_str().unwrap();
    let child = Path::new(prepared["cwd"].as_str().unwrap());
    fs::write(child.join("a.txt"), "fork\n").unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/fork-reviews/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let comparison = payload(response).await;
    assert_eq!(comparison["files"][0]["baseContent"], "base\n");
    fs::write(source.join("a.txt"), "new parent\n").unwrap();
    let response = router
        .oneshot(post(
            &format!("/api/fork-reviews/{id}/apply"),
            json!({"revision":comparison["revision"],"selections":[{"path":"a.txt"}]}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(source.join("a.txt")).unwrap(),
        "new parent\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn verification_routes_run_real_command_and_reject_client_cwd_override() {
    let (state, root) = test_state("verification-delivery-http");
    let source = root.join("project");
    repo(&source);
    let binding = state
        .task_binding_service
        .create(serde_json::from_value(json!({"title":"HTTP check","projectPath":source})).unwrap())
        .unwrap();
    let router = build_router(state);
    let url = format!("/api/task-bindings/{}/verification/run", binding.id);
    let response = router
        .clone()
        .oneshot(post(
            &url,
            json!({"command":"echo evidence","timeoutSecs":5}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result = payload(response).await;
    assert_eq!(result["evidence"][0]["exitCode"], 0);
    assert!(result["evidence"][0]["stdout"]
        .as_str()
        .unwrap()
        .contains("evidence"));
    let response = router
        .oneshot(post(
            &url,
            json!({"command":"echo evidence","cwd":"/foreign"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    fs::remove_dir_all(root).unwrap();
}
