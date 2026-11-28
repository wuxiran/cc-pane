use super::*;
use crate::models::provider::{ProviderEndpoints, ProviderOrigin, ProviderOriginKind};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type Seen = Arc<StdMutex<Vec<String>>>;

/// 极简 mock 网关：按路径前缀回固定 JSON，记下每个请求行和是否带了鉴权头。
async fn mock_gateway(routes: Vec<(&'static str, u16, String)>) -> (u16, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::new(StdMutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let routes = routes.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                let line = text.lines().next().unwrap_or_default().to_string();
                let lower = text.to_ascii_lowercase();
                let authed = lower.contains("\nauthorization:") || lower.contains("\nx-api-key:");
                log.lock()
                    .unwrap()
                    .push(format!("{line}{}", if authed { " [auth]" } else { "" }));
                let path = line.split(' ').nth(1).unwrap_or_default();
                let (status, body) = routes
                    .iter()
                    .find(|(prefix, _, _)| path.starts_with(prefix))
                    .map(|(_, status, body)| (*status, body.clone()))
                    .unwrap_or((404, "{}".to_string()));
                let response = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

fn config_dir_with_port(port: u16, providers_json: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("gateway.json"),
        format!(r#"{{"addr":"127.0.0.1:{port}"}}"#),
    )
    .unwrap();
    std::fs::write(dir.path().join("providers.json"), providers_json).unwrap();
    dir
}

fn gateway_provider(port: u16, external_id: Option<&str>) -> Provider {
    Provider {
        id: "p".into(),
        endpoints: ProviderEndpoints {
            anthropic: Some(format!("http://127.0.0.1:{port}")),
            ..ProviderEndpoints::default()
        },
        source: external_id.map(|id| ProviderOrigin {
            kind: ProviderOriginKind::Magpie,
            external_id: Some(id.into()),
            imported_at: None,
            fingerprint: None,
        }),
        ..Provider::default()
    }
}

const ROUTE_BODY: &str = r#"{"session":"abc","seq":7,"route":{"id":3,"asked":"group/code","group":"code",
 "rule":{"n":1,"use":"claude/opus","pick":"high"},"model":"copilot/claude-opus-5.5","effort":"high",
 "tries":[{"model":"claude/claude-opus-5-5","done":true,"status":429,"fail":"rate limited"},
          {"model":"copilot/claude-opus-5.5","done":false}],
 "done":false,"ttft_ms":420,"unknown_field":{"x":1}}}"#;

#[test]
fn session_key_follows_magpie_session_of() {
    assert_eq!(magpie_session_key("  abc  ").as_deref(), Some("abc"));
    assert_eq!(magpie_session_key("new"), None);
    assert_eq!(magpie_session_key("   "), None);
    let long = "a".repeat(200);
    assert_eq!(magpie_session_key(&long).unwrap().len(), 128);
    // 多字节字符不能截在中间
    let wide = "é".repeat(100);
    let key = magpie_session_key(&wide).unwrap();
    assert!(key.len() <= 128 && key.chars().all(|c| c == 'é'));
}

#[test]
fn provider_match_requires_loopback_and_gateway_port() {
    assert!(provider_points_to_gateway(
        &gateway_provider(3425, None),
        3425
    ));
    assert!(!provider_points_to_gateway(
        &gateway_provider(3425, None),
        3426
    ));
    let mut lan = gateway_provider(3425, None);
    lan.endpoints.anthropic = Some("http://192.168.1.2:3425".into());
    assert!(!provider_points_to_gateway(&lan, 3425));
}

#[test]
fn catalog_splits_groups_and_models_and_dedups() {
    let rows: ListEnvelope<ModelRow> = serde_json::from_str(
        r#"{"object":"list","data":[
            {"id":"group/code","display_name":"Code","magpie_label":"Code group"},
            {"id":"claude/claude-opus-5-5","display_name":"Opus","context_window":200000},
            {"id":"claude/claude-opus-5-5"},
            {"id":"  "},
            {"id":"group/fast","display_name":"group/fast"}]}"#,
    )
    .unwrap();
    let (groups, models) = split_catalog(rows.data);
    assert_eq!(
        groups.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
        ["group/code", "group/fast"]
    );
    assert_eq!(groups[0].label.as_deref(), Some("Code group"));
    assert_eq!(groups[1].label, None, "label equal to id is dropped");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].context_window_tokens, Some(200_000));
}

#[test]
fn quota_scope_filters_by_provider_but_never_empties() {
    let quotas = vec![
        MagpieQuota {
            provider: "claude".into(),
            ..MagpieQuota::default()
        },
        MagpieQuota {
            provider: "copilot".into(),
            ..MagpieQuota::default()
        },
    ];
    assert_eq!(scope_quotas(quotas.clone(), &["claude".into()]).len(), 1);
    assert_eq!(scope_quotas(quotas.clone(), &["nope".into()]).len(), 2);
    assert_eq!(scope_quotas(quotas, &[]).len(), 2);
}

#[test]
fn quota_scope_reads_group_members_from_config() {
    let dir = config_dir_with_port(
        1,
        r#"{"groups":[{"id":"code","members":["claude/opus","copilot/opus","claude/sonnet"]}]}"#,
    );
    let group = gateway_provider(1, Some("group:code"));
    assert_eq!(quota_scope_for(&group, dir.path()), ["claude", "copilot"]);
    let relay = gateway_provider(1, Some("myrelay"));
    assert_eq!(quota_scope_for(&relay, dir.path()), ["myrelay"]);
    assert!(quota_scope_for(&gateway_provider(1, None), dir.path()).is_empty());
}

#[test]
fn switch_tracker_counts_member_changes_only() {
    let mut tracker = SwitchTracker::default();
    let route = |model: &str| MagpieRoute {
        asked: "group/code".into(),
        model: Some(model.into()),
        ..MagpieRoute::default()
    };
    assert_eq!(tracker.observe(Some(&route("a/x"))), 0);
    assert_eq!(tracker.observe(Some(&route("a/x"))), 0);
    assert_eq!(tracker.observe(None), 0);
    assert_eq!(tracker.observe(Some(&route("b/y"))), 1);
    assert_eq!(tracker.observe(Some(&route("a/x"))), 2);
}

#[tokio::test]
async fn route_is_parsed_and_sent_without_key_with_long_poll_params() {
    let (port, seen) = mock_gateway(vec![("/v1/magpie/route", 200, ROUTE_BODY.into())]).await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let provider = gateway_provider(port, Some("group:code"));

    let status = service
        .session_route(Some(&provider), Some(" abc "), Some(5), Some(90))
        .await;
    assert!(status.available);
    assert_eq!(status.session_key.as_deref(), Some("abc"));
    assert_eq!(status.seq, 7);
    let route = status.route.unwrap();
    assert_eq!(route.current_model(), "copilot/claude-opus-5.5");
    assert_eq!(route.rule.as_ref().unwrap().pick.as_deref(), Some("high"));
    assert_eq!(route.tries.len(), 2);
    assert_eq!(route.tries[0].fail.as_deref(), Some("rate limited"));
    assert_eq!(route.ttft_ms, Some(420));

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    // wait 被夹到 25s；不带任何鉴权头
    assert!(
        requests[0].starts_with("GET /v1/magpie/route?session=abc&after=5&wait=25 "),
        "{requests:?}"
    );
    assert!(!requests[0].contains("[auth]"));

    // 前端序列化是 camelCase
    let json = serde_json::to_value(
        &service
            .session_route(Some(&provider), Some("abc"), None, None)
            .await,
    )
    .unwrap();
    assert_eq!(json["route"]["ttftMs"], 420);
    assert_eq!(json["route"]["rule"]["useMember"], "claude/opus");
    assert_eq!(json["switchCount"], 0);
}

#[tokio::test]
async fn null_route_is_available_but_empty() {
    let (port, _) = mock_gateway(vec![(
        "/v1/magpie/route",
        200,
        r#"{"session":"s","seq":0,"route":null}"#.into(),
    )])
    .await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let status = service
        .session_route(Some(&gateway_provider(port, None)), Some("s"), None, None)
        .await;
    assert!(status.available);
    assert!(status.route.is_none());
}

#[tokio::test]
async fn route_degrades_silently() {
    // 网关不在线：端口关着
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let dir = config_dir_with_port(closed, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), closed);
    let provider = gateway_provider(closed, None);
    assert_eq!(
        service
            .session_route(Some(&provider), Some("s"), None, None)
            .await,
        MagpieRouteStatus::unavailable()
    );

    // 网关回 403 / 垃圾 JSON
    let (port, _) = mock_gateway(vec![
        ("/v1/magpie/route?session=bad", 200, "not json".into()),
        ("/v1/magpie/route", 403, r#"{"error":"no"}"#.into()),
    ])
    .await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let provider = gateway_provider(port, None);
    assert!(
        !service
            .session_route(Some(&provider), Some("s"), None, None)
            .await
            .available
    );
    assert!(
        !service
            .session_route(Some(&provider), Some("bad"), None, None)
            .await
            .available
    );

    // 供应商不指向网关 / 没有会话 id / 没有配置目录：不发请求
    let (port, seen) = mock_gateway(vec![("/", 200, ROUTE_BODY.into())]).await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let other = gateway_provider(port.wrapping_add(1), None);
    assert!(
        !service
            .session_route(Some(&other), Some("s"), None, None)
            .await
            .available
    );
    assert!(
        !service
            .session_route(None, Some("s"), None, None)
            .await
            .available
    );
    assert!(
        !service
            .session_route(Some(&gateway_provider(port, None)), Some("new"), None, None)
            .await
            .available
    );
    let empty = tempfile::tempdir().unwrap();
    let unconfigured = MagpieLiveService::for_test(empty.path().to_path_buf(), port);
    assert!(
        !unconfigured
            .session_route(Some(&gateway_provider(port, None)), Some("s"), None, None)
            .await
            .available
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn switch_count_accumulates_across_polls() {
    let (port, _) = mock_gateway(vec![
        (
            "/v1/magpie/route?session=one",
            200,
            r#"{"seq":1,"route":{"asked":"group/g","model":"a/x","tries":[]}}"#.into(),
        ),
        (
            "/v1/magpie/route?session=two",
            200,
            r#"{"seq":2,"route":{"asked":"group/g","model":"b/y","tries":null}}"#.into(),
        ),
    ])
    .await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let provider = gateway_provider(port, None);
    // 不同会话各自计数
    service
        .session_route(Some(&provider), Some("one"), None, None)
        .await;
    let status = service
        .session_route(Some(&provider), Some("two"), None, None)
        .await;
    assert_eq!(status.switch_count, 0);
    // 同一会话：模拟换成员
    service.observe_switch(
        "one",
        Some(&MagpieRoute {
            model: Some("c/z".into()),
            ..MagpieRoute::default()
        }),
    );
    let status = service
        .session_route(Some(&provider), Some("one"), None, None)
        .await;
    assert_eq!(status.switch_count, 2);
}

#[tokio::test]
async fn quotas_are_read_kept_and_scoped() {
    let body = r#"{"object":"list","data":[
        {"provider":"claude","name":"a@example.com","kind":"subscription","plan":"max",
         "windows":[{"name":"5h","used":62,"remaining":38,"resetsAt":"2026-11-27T10:00:00Z"}],"last":true},
        {"provider":"deepseek","name":"key","kind":"balance","balance":"$3.20","windows":null}]}"#;
    let (port, seen) = mock_gateway(vec![("/v1/magpie/quotas", 200, body.into())]).await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);

    let report = service
        .provider_quotas(&gateway_provider(port, Some("claude")))
        .await;
    assert!(report.available);
    assert_eq!(report.quotas.len(), 1);
    assert_eq!(report.quotas[0].windows[0].used, 62.0);
    assert!(report.quotas[0].last);

    let all = service.provider_quotas(&gateway_provider(port, None)).await;
    assert_eq!(all.quotas.len(), 2);
    assert!(all.quotas[1].windows.is_empty());

    let requests = seen.lock().unwrap().clone();
    assert!(requests
        .iter()
        .all(|line| line.starts_with("GET /v1/magpie/quotas?kept=1 ") && !line.contains("[auth]")));

    // 不指向网关的供应商：不发请求
    let before = seen.lock().unwrap().len();
    let mut remote = gateway_provider(port, Some("claude"));
    remote.endpoints.anthropic = Some("https://api.example.com".into());
    assert!(!service.provider_quotas(&remote).await.available);
    assert_eq!(seen.lock().unwrap().len(), before);
}

#[tokio::test]
async fn catalog_lists_live_groups_and_caches_offline() {
    let body = r#"{"object":"list","data":[{"id":"group/code"},{"id":"claude/claude-opus-5-5"}]}"#;
    let (port, seen) = mock_gateway(vec![("/v1/models", 200, body.into())]).await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    let catalog = service.catalog(Some(&gateway_provider(port, None))).await;
    assert!(catalog.available);
    assert_eq!(catalog.groups.len(), 1);
    assert_eq!(catalog.models.len(), 1);
    // 第二次走缓存
    service.catalog(None).await;
    assert_eq!(seen.lock().unwrap().len(), 1);
    // 供应商不指向 Magpie：空
    let other = gateway_provider(port.wrapping_add(1), None);
    assert!(!service.catalog(Some(&other)).await.available);

    // 网关 500：不可用
    let (port, _) = mock_gateway(vec![("/v1/models", 500, "{}".into())]).await;
    let dir = config_dir_with_port(port, "{}");
    let service = MagpieLiveService::for_test(dir.path().to_path_buf(), port);
    assert_eq!(service.catalog(None).await, MagpieCatalog::default());
}
