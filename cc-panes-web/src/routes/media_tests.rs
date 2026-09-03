use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{
    provider::{Provider, ProviderType},
    CreateMediaNodeRequest, CreateMediaRunRequest, MediaKind, MediaOperation, MediaProviderRef,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

fn provider(id: &str, base_url: Option<&str>) -> Provider {
    Provider {
        id: id.to_string(),
        name: id.to_string(),
        provider_type: ProviderType::OpenAI,
        api_key: Some("test-key".to_string()),
        base_url: base_url.map(str::to_string),
        region: None,
        project_id: None,
        aws_profile: None,
        config_dir: None,
        models: Vec::new(),
        default_model_id: None,
        is_default: false,
    }
}

#[tokio::test]
async fn capability_route_keeps_protocol_specific_contracts() {
    let (state, _root) =
        crate::routes::launch_profiles::launch_profiles_tests::test_state("media-capabilities");
    for (id, protocol) in [
        ("openai", "open_ai_compatible"),
        ("sub2", "sub2api"),
        ("comfy", "comfyui"),
    ] {
        state
            .provider_service
            .add_provider(provider(id, Some("http://127.0.0.1:8188/")))
            .expect("provider persists");
        let Json(capabilities) = get_provider_capabilities(
            State(state.clone()),
            Query(MediaCapabilitiesQuery {
                provider_id: id.to_string(),
                protocol: Some(protocol.to_string()),
            }),
        )
        .await
        .expect("capabilities route");
        assert_eq!(capabilities.provider_id, id);
        assert_eq!(capabilities.protocol.as_str(), protocol);
        // docs/99 A4: OpenAI-compatible endpoints only implement synchronous
        // image generation/edits; sub2api and comfy keep image+video async.
        if protocol == "open_ai_compatible" {
            assert_eq!(capabilities.kinds.len(), 1);
            assert!(!capabilities.supports_async_jobs);
        } else {
            assert_eq!(capabilities.kinds.len(), 2);
            assert!(capabilities.supports_async_jobs);
        }
        assert!(!capabilities.operations.is_empty());
        assert_eq!(capabilities.supports_cancel, protocol == "comfyui");
    }
}

#[tokio::test]
async fn capability_route_reports_provider_and_protocol_validation_errors() {
    let (state, _root) = crate::routes::launch_profiles::launch_profiles_tests::test_state(
        "media-capabilities-errors",
    );
    let Err((status, Json(error))) = get_provider_capabilities(
        State(state.clone()),
        Query(MediaCapabilitiesQuery {
            provider_id: "missing".to_string(),
            protocol: None,
        }),
    )
    .await
    else {
        panic!("missing provider must fail");
    };
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error.code(), Some("MEDIA_PROVIDER_NOT_FOUND"));

    state
        .provider_service
        .add_provider(provider("invalid-protocol", Some("https://example.test/")))
        .expect("provider persists");
    let Err((status, Json(error))) = get_provider_capabilities(
        State(state.clone()),
        Query(MediaCapabilitiesQuery {
            provider_id: "invalid-protocol".to_string(),
            protocol: Some("unknown".to_string()),
        }),
    )
    .await
    else {
        panic!("invalid protocol must fail");
    };
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code(), Some("MEDIA_PROTOCOL_INVALID"));

    state
        .provider_service
        .add_provider(provider("missing-url", None))
        .expect("provider persists");
    let Err((status, Json(error))) = get_provider_capabilities(
        State(state),
        Query(MediaCapabilitiesQuery {
            provider_id: "missing-url".to_string(),
            protocol: Some("comfyui".to_string()),
        }),
    )
    .await
    else {
        panic!("missing ComfyUI URL must fail");
    };
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code(), Some("COMFY_PROVIDER_URL_REQUIRED"));
}

#[tokio::test]
async fn run_creation_uses_current_provider_config_fingerprint() {
    let (state, _root) =
        crate::routes::launch_profiles::launch_profiles_tests::test_state("media-run-config");
    state
        .provider_service
        .add_provider(provider(
            "media-run-provider",
            Some("https://api.example.test/v1"),
        ))
        .expect("provider persists");
    let node = state
        .media_service
        .create_node(CreateMediaNodeRequest {
            workspace_id: "workspace".to_string(),
            layout_id: "layout".to_string(),
            kind: MediaKind::Image,
            title: "Image generation".to_string(),
            default_operation: Some(MediaOperation::TextToImage),
            provider_ref: Some(MediaProviderRef {
                provider_id: "media-run-provider".to_string(),
                model_id: "image-model".to_string(),
            }),
            parameters: Some(serde_json::json!({
                "providerProtocol": "open_ai_compatible"
            })),
        })
        .expect("media node");
    let request = CreateMediaRunRequest {
        node_id: node.id,
        operation: MediaOperation::TextToImage,
        request: serde_json::json!({"prompt": "same prompt"}),
        client_request_id: None,
        input_asset_ids: Vec::new(),
        priority: None,
        cache_policy: None,
    };

    let Json(first) = create_run(State(state.clone()), Json(request.clone()))
        .await
        .expect("first run");
    state
        .provider_service
        .update_provider(provider(
            "media-run-provider",
            Some("https://api.example.test/v2"),
        ))
        .expect("provider endpoint update");
    let Json(changed) = create_run(State(state), Json(request))
        .await
        .expect("changed endpoint run");

    assert_eq!(first.request, changed.request);
    assert_ne!(first.execution_fingerprint, changed.execution_fingerprint);
}

#[tokio::test]
async fn comfy_resource_routes_proxy_stats_and_memory_release() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let path = String::from_utf8_lossy(&request)
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or_default()
                .to_string();
            let body = if path == "/system_stats" {
                br#"{"system":{"ram_total":100,"ram_free":40},"devices":[]}"#.to_vec()
            } else {
                b"{}".to_vec()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        }
    });
    let (state, _root) =
        crate::routes::launch_profiles::launch_profiles_tests::test_state("media-comfy-resources");
    state
        .provider_service
        .add_provider(provider(
            "comfy-resources-route",
            Some(&format!("http://{address}/")),
        ))
        .expect("provider persists");
    let Json(stats) = get_comfy_system_stats(
        State(state.clone()),
        Query(ComfySystemStatsQuery {
            provider_id: "comfy-resources-route".to_string(),
        }),
    )
    .await
    .expect("stats route");
    assert_eq!(stats.system.ram_free, Some(40));
    let Json(release) = free_comfy_memory(
        State(state),
        Json(ComfyFreeMemoryRequest {
            provider_id: "comfy-resources-route".to_string(),
            unload_models: true,
            free_memory: true,
        }),
    )
    .await
    .expect("free route");
    assert!(release.accepted);
    server.await.unwrap();
}
