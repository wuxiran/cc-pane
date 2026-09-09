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

#[test]
fn sub2api_image_body_whitelists_parameters_and_splits_mask() {
    let mut value = request("gpt-image-2");
    value.operation = MediaOperation::Edit;
    value.parameters = json!({
        "size": "1024x1536",
        "n": 2,
        "quality": "high",
        // UI-only fields that must never reach the wire.
        "steps": 28,
        "cfgScale": 7,
        "sampler": "euler",
        "seedMode": "random",
        "negativePrompt": "blurry",
        "aspectRatio": "1:1",
    });
    value.input_assets = vec![
        MediaInputAsset {
            url: Some("https://cdn.example.test/source.png".to_string()),
            data: None,
            mime_type: Some("image/png".to_string()),
            metadata: json!({"role": "reference"}),
        },
        MediaInputAsset {
            url: None,
            data: Some("bWFzaw==".to_string()),
            mime_type: Some("image/png".to_string()),
            metadata: json!({"role": "mask"}),
        },
    ];
    let body = super::sub2api_wire_body(&value).expect("wire body");
    assert_eq!(body["model"], "gpt-image-2");
    assert_eq!(body["prompt"], "a quiet lake");
    assert_eq!(body["size"], "1024x1536");
    assert_eq!(body["n"], 2);
    assert_eq!(body["quality"], "high");
    assert_eq!(body["response_format"], "url");
    assert_eq!(body["image"], "https://cdn.example.test/source.png");
    assert_eq!(body["mask"], "data:image/png;base64,bWFzaw==");
    for rejected in [
        "steps",
        "cfgScale",
        "sampler",
        "seedMode",
        "negativePrompt",
        "aspectRatio",
        "input",
    ] {
        assert!(
            body.get(rejected).is_none(),
            "field {rejected} leaked to the wire"
        );
    }
}

#[test]
fn sub2api_video_body_maps_frames_references_and_whitelisted_fields() {
    let image = |name: &str| MediaInputAsset {
        url: Some(format!("https://cdn.example.test/{name}.png")),
        data: None,
        mime_type: Some("image/png".to_string()),
        metadata: json!({"role": "reference"}),
    };
    let value = NormalizedMediaRequest {
        operation: MediaOperation::ImageToVideo,
        kind: MediaKind::Video,
        model: "seedance-2.0-z".to_string(),
        prompt: Some("camera push in".to_string()),
        input_assets: vec![
            image("first"),
            image("tail"),
            image("reference"),
            MediaInputAsset {
                url: Some("https://cdn.example.test/clip.mp4".to_string()),
                data: None,
                mime_type: Some("video/mp4".to_string()),
                metadata: Value::Null,
            },
        ],
        parameters: json!({
            "frameMode": "firstLast",
            "duration": 6,
            "resolution": "720P",
            "aspectRatio": "9:16",
            // UI-only fields.
            "fps": 24,
            "codec": "h264",
            "colorSpace": "bt709",
            "frameCount": 144,
            "audio": true,
            "n": 1,
        }),
        client_request_id: Some("request-video".to_string()),
    };
    let body = super::sub2api_wire_body(&value).expect("wire body");
    assert_eq!(body["model"], "seedance-2.0-z");
    assert_eq!(body["duration"], 6);
    assert_eq!(body["resolution"], "720p");
    assert_eq!(body["aspect_ratio"], "9:16");
    assert_eq!(body["image"], "https://cdn.example.test/first.png");
    assert_eq!(body["image_tail"], "https://cdn.example.test/tail.png");
    assert_eq!(
        body["images"],
        json!(["https://cdn.example.test/reference.png"])
    );
    assert_eq!(body["video"], "https://cdn.example.test/clip.mp4");
    for rejected in [
        "fps",
        "codec",
        "colorSpace",
        "frameCount",
        "audio",
        "n",
        "response_format",
        "size",
    ] {
        assert!(
            body.get(rejected).is_none(),
            "field {rejected} leaked to the wire"
        );
    }
}

#[test]
fn sub2api_text_to_video_keeps_all_images_as_references() {
    let value = NormalizedMediaRequest {
        operation: MediaOperation::TextToVideo,
        kind: MediaKind::Video,
        model: "grok-video-3-y".to_string(),
        prompt: Some("@image1 rolls toward @image2".to_string()),
        input_assets: vec![
            MediaInputAsset {
                url: Some("https://cdn.example.test/a.png".to_string()),
                data: None,
                mime_type: Some("image/png".to_string()),
                metadata: Value::Null,
            },
            MediaInputAsset {
                url: Some("https://cdn.example.test/b.png".to_string()),
                data: None,
                mime_type: Some("image/png".to_string()),
                metadata: Value::Null,
            },
        ],
        parameters: json!({"duration": 10}),
        client_request_id: None,
    };
    let body = super::sub2api_wire_body(&value).expect("wire body");
    assert!(body.get("image").is_none());
    assert_eq!(
        body["images"],
        json!([
            "https://cdn.example.test/a.png",
            "https://cdn.example.test/b.png"
        ])
    );
}

#[test]
fn sub2api_statuses_map_to_durable_states() {
    assert_eq!(
        super::parse_sub2api_status(Some("queued")).0,
        MediaRunStatus::Queued
    );
    assert_eq!(
        super::parse_sub2api_status(Some("running")).0,
        MediaRunStatus::Processing
    );
    assert_eq!(
        super::parse_sub2api_status(Some("succeeded")).0,
        MediaRunStatus::Succeeded
    );
    assert_eq!(
        super::parse_sub2api_status(Some("failed")).0,
        MediaRunStatus::Failed
    );
    let (expired, message) = super::parse_sub2api_status(Some("expired"));
    assert_eq!(expired, MediaRunStatus::Failed);
    assert!(message.is_some());
    let (storage_failed, message) = super::parse_sub2api_status(Some("succeeded_storage_failed"));
    assert_eq!(storage_failed, MediaRunStatus::Failed);
    assert!(message.is_some());
    // Unknown states must not kill the poll loop.
    assert_eq!(
        super::parse_sub2api_status(Some("verifying")).0,
        MediaRunStatus::Processing
    );
}

#[tokio::test]
async fn sub2api_adapter_submits_polls_and_downloads_with_auth() {
    let (base_url, server) = spawn_sub2api_server().await;
    let profile = MediaProviderProfile::new(
        "sub2api",
        base_url.clone(),
        Some("sk-test-secret".to_string()),
    )
    .expect("profile")
    .with_timeout(Duration::from_secs(10));
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let adapter = Sub2ApiMediaAdapter::with_client(client, profile).expect("adapter");
    assert_eq!(adapter.protocol(), MediaProtocol::Sub2Api);
    let capabilities = adapter.capabilities();
    assert!(!capabilities.supports_cancel);
    assert!(capabilities.kinds.contains(&MediaKind::Video));

    let job = adapter
        .submit(request("gpt-image-2"))
        .await
        .expect("submit");
    assert_eq!(job.id, "imgtask_1");
    assert_eq!(job.status, MediaRunStatus::Queued);

    let status = adapter
        .poll_for_kind(&job, MediaKind::Image)
        .await
        .expect("poll");
    assert_eq!(status.status, MediaRunStatus::Succeeded);
    let output = status.outputs.first().expect("output");
    assert_eq!(output.kind, Some(MediaKind::Image));

    let downloaded = adapter.download(output).await.expect("download");
    assert_eq!(downloaded.mime_type, "image/png");
    assert_eq!(downloaded.bytes, b"png-bytes");
    server.await.expect("server");
}

#[tokio::test]
async fn fetch_provider_model_ids_lists_sorted_unique_ids() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    let base_url = format!("http://{address}");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buffer = [0_u8; 8 * 1024];
        let length = socket.read(&mut buffer).await.expect("read");
        let request = String::from_utf8_lossy(&buffer[..length]).to_string();
        assert!(
            request.starts_with("GET /v1/models"),
            "unexpected request: {request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-models"),
            "missing bearer auth"
        );
        let body = br#"{"object":"list","data":[{"id":"seedance-2.0"},{"id":"gpt-image-2"},{"id":"gpt-image-2"},{"id":"wan3.0-video"}]}"#;
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.expect("headers");
        socket.write_all(body).await.expect("body");
    });
    let ids =
        super::fetch_provider_model_ids(&base_url, Some("sk-models"), Duration::from_secs(10))
            .await
            .expect("model ids");
    assert_eq!(ids, vec!["gpt-image-2", "seedance-2.0", "wan3.0-video"]);
    server.await.expect("server");
}

/// Minimal Sub2API mock: image task submit (asserts Idempotency-Key), poll,
/// and an authorized file download.
async fn spawn_sub2api_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    let base_url = format!("http://{address}");
    let response_base = base_url.clone();
    let handle = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let request = read_mock_request(&mut socket).await;
            let lowercase = request.to_ascii_lowercase();
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");
            let authorized = lowercase.contains("authorization: bearer sk-test-secret");
            let (status, content_type, body) = if !authorized {
                (
                    "401 Unauthorized",
                    "application/json",
                    b"{\"error\":\"unauthorized\"}".to_vec(),
                )
            } else {
                match path {
                    "/api/v1/image-tasks" => {
                        if !lowercase.contains("idempotency-key:") {
                            (
                                "400 Bad Request",
                                "application/json",
                                b"{\"error\":\"missing Idempotency-Key\"}".to_vec(),
                            )
                        } else {
                            (
                                "202 Accepted",
                                "application/json",
                                b"{\"object\":\"image_task\",\"task_id\":\"imgtask_1\",\"status\":\"queued\"}"
                                    .to_vec(),
                            )
                        }
                    }
                    "/api/v1/image-tasks/imgtask_1" => (
                        "200 OK",
                        "application/json",
                        format!(
                            "{{\"task_id\":\"imgtask_1\",\"status\":\"succeeded\",\"result\":{{\"created\":1,\"data\":[{{\"url\":\"{response_base}/api/v1/image-tasks/imgtask_1/files/0.png\"}}]}}}}"
                        )
                        .into_bytes(),
                    ),
                    "/api/v1/image-tasks/imgtask_1/files/0.png" => {
                        ("200 OK", "image/png", b"png-bytes".to_vec())
                    }
                    _ => ("404 Not Found", "text/plain", Vec::new()),
                }
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

async fn spawn_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    let base_url = format!("http://{address}");
    let response_base = base_url.clone();
    let handle = tokio::spawn(async move {
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let request = read_mock_request(&mut socket).await;
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

// Drain the complete request before closing a mock socket. A single TCP read can
// contain only headers; closing with unread POST bytes can reset a Windows socket.
async fn read_mock_request(socket: &mut (impl tokio::io::AsyncRead + Unpin)) -> String {
    let mut buffer = [0_u8; 16 * 1024];
    let mut length = 0;
    let header_end = loop {
        let count = socket
            .read(&mut buffer[length..])
            .await
            .expect("read request");
        assert!(count > 0, "incomplete mock request headers");
        length += count;
        if let Some(end) = buffer[..length].windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = std::str::from_utf8(&buffer[..header_end]).expect("request headers");
    let body_length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().expect("content length"))
        .unwrap_or(0);
    let end = header_end + body_length;
    assert!(end <= buffer.len(), "mock request exceeds buffer");
    while length < end {
        let count = socket
            .read(&mut buffer[length..end])
            .await
            .expect("read body");
        assert!(count > 0, "incomplete mock request body");
        length += count;
    }
    String::from_utf8(buffer[..end].to_vec()).expect("request UTF-8")
}

#[tokio::test]
async fn mock_request_reader_waits_for_split_headers_and_post_body() {
    let (mut writer, mut reader) = tokio::io::duplex(128);
    let task = tokio::spawn(async move { read_mock_request(&mut reader).await });
    writer
        .write_all(b"POST /api HTTP/1.1\r\nContent-Len")
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    writer.write_all(b"gth: 5\r\n\r\nhe").await.unwrap();
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    writer.write_all(b"llo").await.unwrap();
    assert_eq!(
        task.await.unwrap(),
        "POST /api HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello"
    );
}
