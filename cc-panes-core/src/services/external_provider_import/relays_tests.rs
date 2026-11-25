use super::*;
use crate::services::external_provider_import::{
    load_external_batch, parse_magpie_providers, parse_magpie_providers_with_gateway,
    ExternalProviderSource,
};

/// 文档（docs/reference.md「Routing groups」）里的形状：成员 `<provider>/<model>`，`routing` 五选一。
const MAGPIE_GROUPS: &str = r#"{
  "providers": null,
  "groups": [
    {"id": "opus-anywhere", "name": "Opus anywhere",
     "members": ["claude/claude-opus-5-5", "copilot/claude-opus-5.5"], "routing": "order"},
    {"id": "code", "name": "Code", "members": ["codex/gpt-5.5", "gemini/gemini-3-pro"],
     "routing": "smart"},
    {"id": "gpts", "name": "GPTs", "members": ["codex/gpt-5.5", "openai/gpt-5"], "routing": "rotate"},
    {"name": "no id"}
  ]
}"#;

#[test]
fn magpie_groups_become_gateway_relays_per_client_family() {
    let batch = parse_magpie_providers(MAGPIE_GROUPS).unwrap();
    assert_eq!(batch.skipped_empty, 1);
    let rows: Vec<(&str, ProviderType)> = batch
        .candidates
        .iter()
        .map(|candidate| (candidate.key.as_str(), candidate.provider.provider_type))
        .collect();
    // 不论成员是什么，每个组都固定 Claude + Codex 两行（网关做协议翻译）
    assert_eq!(
        rows,
        vec![
            (
                "magpie:group:opus-anywhere:anthropic",
                ProviderType::Anthropic
            ),
            ("magpie:group:opus-anywhere:open_ai", ProviderType::OpenAI),
            ("magpie:group:code:anthropic", ProviderType::Anthropic),
            ("magpie:group:code:open_ai", ProviderType::OpenAI),
            ("magpie:group:gpts:anthropic", ProviderType::Anthropic),
            ("magpie:group:gpts:open_ai", ProviderType::OpenAI),
        ]
    );

    let claude = &batch.candidates[2].provider;
    assert_eq!(claude.name, "Code · Claude");
    assert_eq!(
        claude.endpoints.anthropic.as_deref(),
        Some("http://127.0.0.1:3425")
    );
    assert_eq!(claude.default_model_id.as_deref(), Some("group/code"));
    assert_eq!(claude.models.len(), 1);
    assert_eq!(claude.models[0].id, "group/code");
    assert_eq!(claude.api_key.as_deref(), Some(MAGPIE_PLACEHOLDER_KEY));
    let origin = claude.source.as_ref().unwrap();
    assert_eq!(origin.kind, ProviderOriginKind::Magpie);
    assert_eq!(origin.external_id.as_deref(), Some("group:code"));

    let codex = &batch.candidates[3].provider;
    assert_eq!(codex.name, "Code · Codex");
    assert_eq!(codex.default_model_id.as_deref(), Some("group/code"));
    assert_eq!(
        codex.endpoints.responses.as_deref(),
        Some("http://127.0.0.1:3425/v1")
    );
    assert_eq!(codex.codex_wire_api.as_deref(), Some("responses"));

    let relay = batch.candidates[2].relay.as_ref().unwrap();
    assert_eq!(relay.kind, ExternalRelayKind::MagpieGroup);
    assert_eq!(relay.routing.as_deref(), Some("smart"));
    assert_eq!(relay.member_count, Some(2));
    assert!(relay.note.contains("依赖 Magpie 网关运行"));
}

#[test]
fn magpie_group_without_members_or_routing_defaults_to_smart() {
    let batch = parse_magpie_providers_with_gateway(r#"{"groups":[{"id":"g"}]}"#, "127.0.0.1:4000")
        .unwrap();
    assert_eq!(batch.candidates.len(), 2);
    assert_eq!(batch.candidates[0].provider.name, "g · Claude");
    assert_eq!(batch.candidates[1].provider.name, "g · Codex");
    assert_eq!(
        batch.candidates[1].provider.endpoints.responses.as_deref(),
        Some("http://127.0.0.1:4000/v1")
    );
    let relay = batch.candidates[0].relay.as_ref().unwrap();
    assert_eq!(relay.routing.as_deref(), Some("smart"));
    assert_eq!(relay.member_count, Some(0));
}

#[test]
fn magpie_group_reimport_matches_existing_rows_even_after_rename() {
    use crate::services::external_provider_import::is_same_provider;
    let first = parse_magpie_providers(MAGPIE_GROUPS).unwrap();
    let second = parse_magpie_providers(MAGPIE_GROUPS).unwrap();
    for (old, new) in first.candidates.iter().zip(second.candidates.iter()) {
        let mut existing = old.provider.clone();
        // 旧版本导入的名字（「X (Magpie 路由组)」）或用户改过名：仍按来源 id + 类型认出是同一条
        existing.name = "Renamed by user".into();
        assert!(is_same_provider(&existing, &new.provider));
    }
    // Claude 行与 Codex 行互不顶替：同组两行都要能导入
    assert!(!is_same_provider(
        &first.candidates[0].provider,
        &second.candidates[1].provider
    ));
}

#[test]
fn magpie_gateway_addr_comes_from_gateway_json_and_normalizes_wildcards() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("gateway.json"),
        r#"{"addr":"0.0.0.0:3999","pid":1,"serves":"app"}"#,
    )
    .unwrap();
    assert_eq!(read_magpie_gateway_addr(dir.path()), "127.0.0.1:3999");
    assert_eq!(
        normalize_listen_addr("[::]:3425").as_deref(),
        Some("127.0.0.1:3425")
    );
    assert_eq!(
        normalize_listen_addr("[::1]:3425").as_deref(),
        Some("[::1]:3425")
    );
    assert_eq!(normalize_listen_addr("no-port"), None);

    std::fs::write(
        dir.path().join("providers.json"),
        r#"{"providers":null,"groups":[{"id":"x","members":["claude/claude-opus-5-5"]}]}"#,
    )
    .unwrap();
    let batch = load_external_batch(
        ExternalProviderSource::Magpie,
        &dir.path().join("providers.json"),
    )
    .unwrap();
    assert_eq!(batch.candidates.len(), 2);
    assert_eq!(
        batch.candidates[0].provider.endpoints.anthropic.as_deref(),
        Some("http://127.0.0.1:3999")
    );
}

#[test]
fn cc_switch_placeholder_credentials_are_detected() {
    assert!(is_cc_switch_proxy_placeholder(
        Some("PROXY_MANAGED"),
        None,
        &[]
    ));
    assert!(is_cc_switch_proxy_placeholder(
        Some("sk-real"),
        Some("http://127.0.0.1:15721"),
        &[]
    ));
    assert!(is_cc_switch_proxy_placeholder(
        Some("sk-real"),
        Some("http://localhost:16000/v1"),
        &[16000]
    ));
    assert!(!is_cc_switch_proxy_placeholder(
        Some("sk-real"),
        Some("https://relay.example.com"),
        &[15721]
    ));
    assert!(!is_cc_switch_proxy_placeholder(
        Some("sk-real"),
        Some("http://127.0.0.1:8080"),
        &[15721]
    ));
}

fn cc_switch_db(with_proxy: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(dir.path().join("cc-switch.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT,
            in_failover_queue BOOLEAN NOT NULL DEFAULT 0);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO providers VALUES ('1','claude','Real',?1,1)",
        [r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-real","ANTHROPIC_BASE_URL":"https://relay.example.com"}}"#],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO providers VALUES ('2','claude','Taken over',?1,1)",
        [r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"PROXY_MANAGED","ANTHROPIC_BASE_URL":"http://127.0.0.1:15721"}}"#],
    )
    .unwrap();
    if with_proxy {
        conn.execute_batch(
            "CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, proxy_enabled INTEGER NOT NULL DEFAULT 0,
                listen_address TEXT NOT NULL DEFAULT '127.0.0.1', listen_port INTEGER NOT NULL DEFAULT 15721,
                enabled INTEGER NOT NULL DEFAULT 0, auto_failover_enabled INTEGER NOT NULL DEFAULT 0,
                live_takeover_active INTEGER NOT NULL DEFAULT 0);
             INSERT INTO proxy_config VALUES ('claude',1,'0.0.0.0',15721,1,1,1);
             INSERT INTO proxy_config VALUES ('codex',0,'127.0.0.1',15721,1,0,0);
             INSERT INTO proxy_config VALUES ('gemini',0,'127.0.0.1',15721,0,0,0);",
        )
        .unwrap();
    }
    dir
}

#[test]
fn cc_switch_import_skips_placeholders_and_adds_enabled_proxies() {
    let dir = cc_switch_db(true);
    let batch = load_external_batch(
        ExternalProviderSource::CcSwitch,
        &dir.path().join("cc-switch.db"),
    )
    .unwrap();
    let names: Vec<&str> = batch
        .candidates
        .iter()
        .map(|candidate| candidate.provider.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["Real", "cc-switch 代理 (Claude)", "cc-switch 代理 (Codex)"]
    );
    assert_eq!(batch.skipped_items.len(), 1);
    assert_eq!(batch.skipped_items[0].name, "Taken over");
    assert_eq!(batch.skipped_items[0].reason, CC_SWITCH_PLACEHOLDER_REASON);

    let claude = &batch.candidates[1];
    assert_eq!(claude.key, "cc_switch:proxy:claude");
    assert_eq!(
        claude.provider.endpoints.anthropic.as_deref(),
        Some("http://127.0.0.1:15721")
    );
    assert_eq!(
        claude.provider.api_key.as_deref(),
        Some(CC_SWITCH_PROXY_PLACEHOLDER_KEY)
    );
    let origin = claude.provider.source.as_ref().unwrap();
    assert_eq!(origin.kind, ProviderOriginKind::CcSwitch);
    assert_eq!(origin.external_id.as_deref(), Some("proxy:claude"));
    let relay = claude.relay.as_ref().unwrap();
    assert_eq!(relay.kind, ExternalRelayKind::CcSwitchProxy);
    assert_eq!(relay.routing.as_deref(), Some("failover"));
    assert_eq!(relay.member_count, Some(2));
    assert!(relay.note.contains("故障转移由 cc-switch 处理"));

    let codex = &batch.candidates[2].provider;
    assert_eq!(
        codex.endpoints.responses.as_deref(),
        Some("http://127.0.0.1:15721/v1")
    );
}

#[test]
fn older_cc_switch_without_proxy_table_skips_proxies_silently() {
    let dir = cc_switch_db(false);
    let path = dir.path().join("cc-switch.db");
    assert!(load_cc_switch_proxies(&path).is_empty());
    let batch = load_external_batch(ExternalProviderSource::CcSwitch, &path).unwrap();
    assert_eq!(batch.candidates.len(), 1);
    // 占位识别不依赖代理表：默认端口 / PROXY_MANAGED 仍认得出
    assert_eq!(batch.skipped_items.len(), 1);
}
