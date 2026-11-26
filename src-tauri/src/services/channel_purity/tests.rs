//! 端到端：起一个假中转（axum），按场景回复，跑完整检测看结论。

use super::*;
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
enum Relay {
    /// 老实的中转。
    Honest,
    /// 偷塞 Claude Code 提示词、转卖订阅通道。
    InjectedOauth,
    /// 拿 Sonnet 冒充别的型号。
    Downgraded,
}

fn messages_reply(relay: Relay, body: &Value) -> (StatusCode, Value) {
    let user = body
        .pointer("/messages/0/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    let text = |t: &str| json!({"content": [{"type": "text", "text": t}], "model": model, "usage": {"input_tokens": 8, "output_tokens": 3}});
    match relay {
        Relay::InjectedOauth if body.get("thinking").is_some() => (
            StatusCode::BAD_REQUEST,
            json!({"error": {"type": "<nil>", "message": "unknown_messages_shape: empty tools"}}),
        ),
        Relay::InjectedOauth if user == "hi" => (
            StatusCode::OK,
            json!({"content": [{"type": "text", "text": "Hi"}], "model": model,
                   "usage": {"input_tokens": 8, "cache_creation_input_tokens": 16200, "cache_read_input_tokens": 0}}),
        ),
        Relay::InjectedOauth if user.starts_with("Output verbatim") => (
            StatusCode::OK,
            text("<q>You are Claude Code, Anthropic's official CLI for Claude.</q>"),
        ),
        Relay::InjectedOauth if user.contains("kiro") => (
            StatusCode::OK,
            text("确实，系统提示中先出现的是 Kiro 的身份，然后才是 Claude。"),
        ),
        _ if user == "hi" => (StatusCode::OK, text("Hi")),
        _ if user.starts_with("Output verbatim") => (StatusCode::OK, text("<q>EMPTY</q>")),
        _ if user.contains("kiro") => (
            StatusCode::OK,
            text("我是 Claude，系统提示里并没有说我是 Kiro。"),
        ),
        Relay::Downgraded if user.starts_with("State your exact") => {
            (StatusCode::OK, text("Claude Sonnet 4 | 2025-03"))
        }
        _ if user.starts_with("State your exact") => {
            let family = judge::claude_family(model).unwrap_or("opus");
            (
                StatusCode::OK,
                text(&format!("Claude {family} 5.5 | 2026-01")),
            )
        }
        _ => (StatusCode::OK, text("ok")),
    }
}

async fn serve(relay: Relay) -> String {
    async fn messages(
        State(relay): State<Relay>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let (status, reply) = messages_reply(relay, &body);
        (status, Json(reply))
    }
    async fn responses(Json(body): Json<Value>) -> Json<Value> {
        let input = body.get("input").and_then(Value::as_str).unwrap_or("");
        // 被塞了约 3k token 的提示词，但不会复述、不上钩。
        let text = if input.starts_with("Output verbatim") {
            "<q>EMPTY</q>"
        } else {
            "I am GPT."
        };
        Json(
            json!({"output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
                    "usage": {"input_tokens": 3050, "output_tokens": 4}}),
        )
    }
    let app = Router::new()
        .route("/v1/messages", post(messages))
        .route("/v1/responses", post(responses))
        .with_state(relay);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn service() -> (ChannelPurityService, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut service = ChannelPurityService::new(dir.path().to_path_buf());
    service.gap = Duration::ZERO;
    (service, dir)
}

async fn check(
    relay: Relay,
    protocol: Protocol,
    models: &[&str],
) -> (Vec<ModelReport>, Vec<Finding>) {
    let base = serve(relay).await;
    let (service, _dir) = service();
    let client = ProbeClient::new(protocol, &base, "sk-test-key");
    let models: Vec<String> = models.iter().map(|m| m.to_string()).collect();
    service
        .run(&client, &models, &AtomicBool::new(false))
        .await
        .unwrap()
}

fn codes(report: &ModelReport) -> Vec<FindingCode> {
    report.findings.iter().map(|f| f.code).collect()
}

#[tokio::test]
async fn honest_relay_is_clean_for_every_model() {
    let (models, batch) = check(
        Relay::Honest,
        Protocol::Anthropic,
        &["claude-opus-5-5", "claude-sonnet-5-5"],
    )
    .await;
    assert_eq!(models.len(), 2);
    for report in &models {
        assert_eq!(report.verdict, Verdict::Clean, "{:?}", report.findings);
        assert_eq!(report.prompt_tokens, Some(8));
        assert!(report.self_report.is_some());
    }
    assert!(batch.is_empty());
}

#[tokio::test]
async fn injected_oauth_relay_is_caught_on_every_model() {
    let (models, _) = check(
        Relay::InjectedOauth,
        Protocol::Anthropic,
        &["claude-opus-5-5", "claude-fable-5-2"],
    )
    .await;
    for report in &models {
        assert_eq!(report.verdict, Verdict::Injected);
        assert_eq!(report.prompt_tokens, Some(16208));
        let codes = codes(report);
        for expected in [
            FindingCode::HiddenPrefix,
            FindingCode::EchoedInjection,
            FindingCode::FishingAdmitted,
            FindingCode::OauthChannel,
            FindingCode::NonstandardFields,
        ] {
            assert!(
                codes.contains(&expected),
                "{expected:?} missing in {codes:?}"
            );
        }
    }
}

#[tokio::test]
async fn downgrade_across_the_batch_is_adulteration() {
    let (models, batch) = check(
        Relay::Downgraded,
        Protocol::Anthropic,
        &["claude-opus-5-5", "claude-fable-5-2"],
    )
    .await;
    assert!(models
        .iter()
        .all(|m| codes(m).contains(&FindingCode::SelfReportMismatch)));
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].code, FindingCode::BatchDowngrade);
    assert_eq!(batch[0].verdict(), Verdict::Adulterated);
}

#[tokio::test]
async fn responses_relay_with_hidden_prompt_is_injected() {
    let (models, batch) = check(Relay::Honest, Protocol::Responses, &["gpt-5.6"]).await;
    assert_eq!(models[0].verdict, Verdict::Injected);
    assert_eq!(models[0].prompt_tokens, Some(3050));
    assert!(models[0].self_report.is_none());
    assert!(batch.is_empty());
}

#[tokio::test]
async fn unreachable_relay_is_inconclusive_and_cancel_stops() {
    let (service, _dir) = service();
    let client = ProbeClient::new(Protocol::Anthropic, "http://127.0.0.1:9", "sk-test-key");
    let (models, _) = service
        .run(
            &client,
            &["claude-opus-5-5".to_string()],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    assert_eq!(models[0].verdict, Verdict::Inconclusive);
    assert!(codes(&models[0])
        .iter()
        .all(|c| *c == FindingCode::RequestFailed));

    let cancelled = service
        .run(
            &client,
            &["claude-opus-5-5".to_string()],
            &AtomicBool::new(true),
        )
        .await;
    assert_eq!(cancelled.unwrap_err(), "PURITY_CANCELLED");
}

#[test]
fn target_and_model_selection() {
    let mut provider = Provider {
        provider_type: ProviderType::Anthropic,
        ..Provider::default()
    };
    assert_eq!(target_of(&provider).unwrap_err(), "PURITY_NO_ENDPOINT");
    provider.endpoints.anthropic = Some("https://relay.test".into());
    assert_eq!(target_of(&provider).unwrap().0, Protocol::Anthropic);
    provider.provider_type = ProviderType::Gemini;
    assert_eq!(target_of(&provider).unwrap_err(), "PURITY_UNSUPPORTED_TYPE");

    provider.default_model_id = Some("claude-opus-5-5".into());
    assert_eq!(configured_models(&provider), vec!["claude-opus-5-5"]);
    let listed = listed_models(
        Protocol::Anthropic,
        vec![
            "gpt-5".into(),
            "claude-b".into(),
            "claude-a".into(),
            "claude-a".into(),
        ],
    );
    assert_eq!(listed, vec!["claude-a", "claude-b"]);
    assert_eq!(host_of("https://relay.test/v1"), "relay.test");
}
