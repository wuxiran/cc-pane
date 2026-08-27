use super::*;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

fn request(model: &str) -> NormalizedMediaRequest {
    NormalizedMediaRequest {
        operation: MediaOperation::TextToImage,
        kind: MediaKind::Image,
        model: model.to_string(),
        prompt: Some("a quiet lake".to_string()),
        input_assets: Vec::new(),
        parameters: json!({"size": "1024x1024"}),
        client_request_id: Some("request-1".to_string()),
    }
}

#[test]
fn parses_sync_and_async_openai_shapes() {
    let sync = parse_submit_response(&json!({
        "created": 1,
        "data": [{"url": "https://cdn.example.test/a.png"}]
    }))
    .expect("sync response");
    assert_eq!(sync.status, MediaRunStatus::Succeeded);
    assert_eq!(sync.outputs.len(), 1);
    assert_eq!(
        sync.outputs[0].url.as_deref(),
        Some("https://cdn.example.test/a.png")
    );

    let async_job = parse_submit_response(&json!({
        "id": "job-7",
        "status": "processing",
        "progress": 42,
        "status_url": "https://api.example.test/jobs/job-7"
    }))
    .expect("async response");
    assert_eq!(async_job.id, "job-7");
    assert_eq!(async_job.status, MediaRunStatus::Processing);
    assert_eq!(async_job.progress, Some(42));

    let status = parse_status_response(
        &json!({
            "id": "job-7",
            "status": "completed",
            "output": [{"video_url": "https://cdn.example.test/a.mp4", "mimeType": "video/mp4"}]
        }),
        "fallback",
    )
    .expect("status response");
    assert_eq!(status.status, MediaRunStatus::Succeeded);
    assert_eq!(status.outputs[0].kind, Some(MediaKind::Video));
}

#[test]
fn async_status_keeps_expected_video_kind_when_payload_is_generic() {
    let status = parse_status_response_for_kind(
        &json!({
            "id": "video-job",
            "status": "completed",
            "output": [{"url": "https://cdn.example.test/generated-media"}]
        }),
        "fallback",
        MediaKind::Video,
    )
    .expect("status response");
    assert_eq!(status.status, MediaRunStatus::Succeeded);
    assert_eq!(status.outputs[0].kind, Some(MediaKind::Video));
}

#[test]
fn profile_debug_and_registry_do_not_expose_secrets() {
    let profile = MediaProviderProfile::new(
        "provider-1",
        "https://api.example.test/v1",
        Some("super-secret-key".to_string()),
    )
    .expect("profile");
    assert!(!format!("{profile:?}").contains("super-secret-key"));
    let adapter = OpenAiCompatibleMediaAdapter::new(profile).expect("adapter");
    let registry = MediaProviderRegistry::new();
    registry
        .register(Arc::new(adapter.clone()))
        .expect("first registration");
    let duplicate = registry.register(Arc::new(adapter));
    assert_eq!(
        duplicate.unwrap_err().code(),
        Some("MEDIA_PROVIDER_DUPLICATE")
    );
    assert_eq!(registry.provider_ids(), vec!["provider-1".to_string()]);
    assert_eq!(registry.capabilities()[0].provider_id, "provider-1");
}

#[test]
fn execution_config_fingerprint_excludes_keys_and_tracks_provider_boundary() {
    let first = MediaProviderProfile::new(
        "provider-1",
        "https://api.example.test/v1",
        Some("first-secret".to_string()),
    )
    .expect("first profile")
    .with_protocol(MediaProtocol::Sub2Api)
    .with_submit_paths("/images", "/videos")
    .with_status_path("/jobs/{job_id}");
    let rotated_key = MediaProviderProfile::new(
        "provider-1",
        "https://api.example.test/v1",
        Some("rotated-secret".to_string()),
    )
    .expect("rotated profile")
    .with_protocol(MediaProtocol::Sub2Api)
    .with_submit_paths("/images", "/videos")
    .with_status_path("/jobs/{job_id}");
    let changed_endpoint = MediaProviderProfile::new(
        "provider-1",
        "https://api.example.test/v2",
        Some("rotated-secret".to_string()),
    )
    .expect("changed profile")
    .with_protocol(MediaProtocol::Sub2Api)
    .with_submit_paths("/images", "/videos")
    .with_status_path("/jobs/{job_id}");

    let first_fingerprint = first.execution_config_fingerprint().expect("fingerprint");
    assert_eq!(
        first_fingerprint,
        rotated_key
            .execution_config_fingerprint()
            .expect("rotated key")
    );
    assert_ne!(
        first_fingerprint,
        changed_endpoint
            .execution_config_fingerprint()
            .expect("changed endpoint")
    );
    assert_ne!(
        first_fingerprint,
        first
            .clone()
            .with_protocol(MediaProtocol::ComfyUi)
            .execution_config_fingerprint()
            .expect("changed protocol")
    );
}

#[tokio::test]
async fn adapter_submits_polls_cancels_and_downloads_from_allowlisted_host() {
    let (base_url, server) = spawn_server().await;
    let profile = MediaProviderProfile::new(
        "mock",
        format!("{base_url}/v1"),
        Some("test-secret".to_string()),
    )
    .expect("profile")
    .with_cancel_path("/jobs/{job_id}/cancel", MediaHttpMethod::Post)
    .with_timeout(Duration::from_secs(10));
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let adapter = OpenAiCompatibleMediaAdapter::with_client(client, profile).expect("adapter");

    let job = adapter
        .submit(request("image-model"))
        .await
        .expect("submit");
    assert_eq!(job.id, "job-1");
    assert_eq!(job.status, MediaRunStatus::Processing);
    let status = adapter.poll(&job).await.expect("poll");
    assert_eq!(status.status, MediaRunStatus::Succeeded);
    let output = status.outputs.first().expect("output");
    let downloaded = adapter.download(output).await.expect("download");
    assert_eq!(downloaded.mime_type, "image/png");
    assert_eq!(downloaded.bytes, b"png-bytes");
    assert_eq!(downloaded.size_bytes, 9);
    assert_eq!(
        downloaded.source_url.as_deref(),
        Some(&format!("{base_url}/v1/media.png")[..])
    );
    adapter.cancel(&job).await.expect("cancel");
    server.await.expect("server");
}

#[test]
fn video_submit_response_keeps_video_output_kind() {
    let value = json!({
        "id": "video-job",
        "status": "succeeded",
        "data": [{"url": "https://cdn.example.test/out.mp4", "mime_type": "video/mp4"}]
    });
    let profile = MediaProviderProfile::new("video-provider", "https://api.example.test/v1", None)
        .expect("profile");
    let adapter = OpenAiCompatibleMediaAdapter::new(profile).expect("adapter");
    let _ = adapter;
    let parsed =
        super::parse_submit_response_for_kind(&value, MediaKind::Video).expect("video response");
    assert_eq!(parsed.outputs[0].kind, Some(MediaKind::Video));
}

#[test]
fn comfy_video_containers_are_inferred_from_download_urls() {
    let mkv = Url::parse("https://cdn.example.test/render.mkv").expect("mkv url");
    let m4v = Url::parse("https://cdn.example.test/render.m4v").expect("m4v url");
    assert_eq!(
        super::mime_from_url(&mkv).as_deref(),
        Some("video/x-matroska")
    );
    assert_eq!(super::mime_from_url(&m4v).as_deref(), Some("video/mp4"));
    assert_eq!(
        super::infer_output_kind(&json!({"url": "https://cdn.example.test/render.mkv"})),
        MediaKind::Video
    );
}

#[test]
fn normalized_request_exposes_role_bearing_mask_as_standard_field() {
    let mut value = request("image-model");
    value.operation = MediaOperation::Edit;
    value.input_assets = vec![
        MediaInputAsset {
            url: None,
            data: Some("source-bytes".to_string()),
            mime_type: Some("image/png".to_string()),
            metadata: json!({"role": "reference"}),
        },
        MediaInputAsset {
            url: None,
            data: Some("mask-bytes".to_string()),
            mime_type: Some("image/png".to_string()),
            metadata: json!({"role": "mask"}),
        },
    ];
    let body = value.to_wire_body().expect("wire body");
    assert_eq!(body["input"][1]["role"], "mask");
    assert_eq!(body["mask"]["data"], "mask-bytes");
}

async fn spawn_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    let base_url = format!("http://{address}");
    let response_base = base_url.clone();
    let handle = tokio::spawn(async move {
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buffer = [0_u8; 16 * 1024];
            let length = socket.read(&mut buffer).await.expect("read");
            let request = String::from_utf8_lossy(&buffer[..length]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");
            let (status, content_type, body) = match path {
                "/v1/images/generations" => (
                    "200 OK",
                    "application/json",
                    format!(
                        "{{\"id\":\"job-1\",\"status\":\"processing\",\"status_url\":\"{response_base}/v1/jobs/job-1\"}}"
                    )
                    .into_bytes(),
                ),
                "/v1/jobs/job-1" => (
                    "200 OK",
                    "application/json",
                    format!(
                        "{{\"id\":\"job-1\",\"status\":\"succeeded\",\"output\":[{{\"url\":\"{response_base}/v1/media.png?signature=hidden\",\"mime_type\":\"image/png\"}}]}}"
                    )
                    .into_bytes(),
                ),
                "/v1/media.png?signature=hidden" => {
                    ("200 OK", "image/png", b"png-bytes".to_vec())
                }
                "/v1/jobs/job-1/cancel" => ("204 No Content", "", Vec::new()),
                _ => ("404 Not Found", "text/plain", Vec::new()),
            };
            let headers = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.expect("headers");
            socket.write_all(&body).await.expect("body");
        }
    });
    (base_url, handle)
}
