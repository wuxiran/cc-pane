//! docs/110 批 2：通用项目级 MCP 写入器（project_mcp / project_mcp_files / project_mcp_dialects）。
//!
//! 覆盖：各方言的条目形态、占位符不落秘密、TOML 收据契约、git 跟踪 / 排除、会话租约回收。
#![cfg(unix)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::process::Command;

use cc_cli_adapters::project_mcp::{self, CcpanesEntry};
use cc_cli_adapters::project_mcp_dialects::{ANTIGRAVITY, CURSOR, GEMINI, GROK, KIMI};
use cc_cli_adapters::{CliAdapterContext, RemoteMcpSpec};
use serde_json::{json, Value};

fn ctx(project: &Path, data: &Path) -> CliAdapterContext {
    CliAdapterContext {
        session_id: "writer-session-1".to_string(),
        project_path: project.to_string_lossy().into_owned(),
        workspace_path: None,
        provider: None,
        executable_override: None,
        adapter_options: HashMap::new(),
        resume_id: None,
        issued_session_id: None,
        skip_mcp: false,
        skip_ccpanes_mcp: false,
        yolo_mode: false,
        append_system_prompt: None,
        initial_prompt: None,
        orchestrator_port: Some(41900),
        orchestrator_token: Some("writer-token".to_string()),
        launch_id: Some("writer-launch".to_string()),
        data_dir: data.to_path_buf(),
        shared_mcp_urls: HashMap::from([
            (
                "bridge".to_string(),
                "http://127.0.0.1:41901/mcp".to_string(),
            ),
            (
                "remote".to_string(),
                "https://remote.example/mcp".to_string(),
            ),
            (
                "legacy".to_string(),
                "https://legacy.example/sse".to_string(),
            ),
        ]),
        shared_mcp_stdio: BTreeMap::new(),
        shared_mcp_remote: BTreeMap::from([
            (
                "remote".to_string(),
                RemoteMcpSpec {
                    transport: "http".to_string(),
                    headers: BTreeMap::from([("X-Key".to_string(), "header-secret".to_string())]),
                },
            ),
            (
                "legacy".to_string(),
                RemoteMcpSpec {
                    transport: "sse".to_string(),
                    headers: BTreeMap::new(),
                },
            ),
        ]),
        allowed_mcp_server_ids: Vec::new(),
        disable_unlisted_mcp_servers: false,
        skill_mount_paths: Vec::new(),
        workspace_mcp_servers: BTreeMap::from([(
            "ws".to_string(),
            json!({ "command": "ws-cmd", "args": ["--flag"], "env": { "A": "1" } }),
        )]),
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[test]
fn placeholder_dialects_keep_secrets_out_of_the_file() {
    let root = tempfile::tempdir().unwrap();
    let (project, data) = (root.path().join("p"), root.path().join("d"));
    fs::create_dir_all(&project).unwrap();
    let ctx = ctx(&project, &data);

    let launch = project_mcp::sync_for_launch(&ctx, &CURSOR, &CcpanesEntry::Http);
    let text = fs::read_to_string(project.join(".cursor/mcp.json")).unwrap();
    assert!(!text.contains("writer-token") && !text.contains("header-secret"));
    let servers = read_json(&project.join(".cursor/mcp.json"))["mcpServers"].clone();
    assert_eq!(
        servers["ccpanes"]["url"],
        "http://127.0.0.1:${env:CC_PANES_API_PORT}/mcp?launchId=${env:CC_PANES_LAUNCH_ID}"
    );
    assert_eq!(servers["ws"]["type"], "stdio");
    assert_eq!(servers["legacy"]["url"], "https://legacy.example/sse");
    let header = servers["remote"]["headers"]["X-Key"].as_str().unwrap();
    let key = header.trim_start_matches("${env:").trim_end_matches('}');
    assert_eq!(launch.env[key], "header-secret");
    assert_eq!(launch.env["CC_PANES_API_TOKEN"], "writer-token");
    assert_eq!(launch.env["CC_PANES_LAUNCH_ID"], "writer-launch");
    assert!(launch.active);
}

#[test]
fn literal_dialects_use_their_own_url_keys_and_skip_unsupported_transports() {
    let root = tempfile::tempdir().unwrap();
    let (project, data) = (root.path().join("p"), root.path().join("d"));
    fs::create_dir_all(&project).unwrap();
    let ctx = ctx(&project, &data);

    project_mcp::sync_for_launch(&ctx, &ANTIGRAVITY, &CcpanesEntry::Http);
    let agy = read_json(&project.join(".agents/mcp_config.json"))["mcpServers"].clone();
    assert_eq!(agy["remote"]["serverUrl"], "https://remote.example/mcp");
    assert!(agy.get("legacy").is_none(), "antigravity has no SSE");

    project_mcp::sync_for_launch(&ctx, &GEMINI, &CcpanesEntry::Http);
    let gemini = read_json(&project.join(".gemini/settings.json"))["mcpServers"].clone();
    assert_eq!(gemini["remote"]["httpUrl"], "https://remote.example/mcp");
    assert_eq!(gemini["legacy"]["url"], "https://legacy.example/sse");

    // Kimi 不展开环境变量，但 HTTP 直连时 token 走 bearerTokenEnvVar
    let launch = project_mcp::sync_for_launch(&ctx, &KIMI, &CcpanesEntry::Http);
    let kimi = read_json(&project.join(".kimi-code/mcp.json"))["mcpServers"].clone();
    assert_eq!(kimi["ccpanes"]["url"], "http://127.0.0.1:41900/mcp");
    assert_eq!(kimi["ccpanes"]["bearerTokenEnvVar"], "CC_PANES_API_TOKEN");
    assert_eq!(kimi["legacy"]["transport"], "sse");
    assert_eq!(launch.env["CC_PANES_API_TOKEN"], "writer-token");
}

#[test]
fn proxy_entry_carries_no_identity_and_gemini_forwards_env() {
    let root = tempfile::tempdir().unwrap();
    let (project, data) = (root.path().join("p"), root.path().join("d"));
    fs::create_dir_all(&project).unwrap();
    let ctx = ctx(&project, &data);
    let proxy = CcpanesEntry::Proxy {
        command: "/opt/ccpanes/cc-panes-ctl".to_string(),
    };

    let launch = project_mcp::sync_for_launch(&ctx, &GEMINI, &proxy);
    let entry = read_json(&project.join(".gemini/settings.json"))["mcpServers"]["ccpanes"].clone();
    assert_eq!(entry["args"], json!(["mcp-proxy"]));
    assert_eq!(entry["env"]["CC_PANES_LAUNCH_ID"], "$CC_PANES_LAUNCH_ID");
    assert_eq!(launch.env["CC_PANES_LAUNCH_ID"], "writer-launch");
    assert_eq!(launch.env["CC_PANES_DATA_DIR"], data.to_string_lossy());

    let mut skipped = ctx.clone();
    skipped.skip_ccpanes_mcp = true;
    project_mcp::sync_for_launch(&skipped, &GEMINI, &proxy);
    let servers = read_json(&project.join(".gemini/settings.json"))["mcpServers"].clone();
    assert!(servers.get("ccpanes").is_none());
    assert!(servers.get("ws").is_some());
}

#[test]
fn toml_sync_keeps_user_content_and_only_touches_receipted_entries() {
    let root = tempfile::tempdir().unwrap();
    let (project, data) = (root.path().join("p"), root.path().join("d"));
    let config = project.join(".grok/config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(
        &config,
        "# team grok settings\nmodel = \"grok-4\"\n\n[mcp_servers.ws]\ncommand = \"user-own\"\n",
    )
    .unwrap();
    let ctx = ctx(&project, &data);

    project_mcp::sync_for_launch(&ctx, &GROK, &CcpanesEntry::Http);
    let text = fs::read_to_string(&config).unwrap();
    assert!(text.contains("# team grok settings") && text.contains("model = \"grok-4\""));
    assert!(
        text.contains("command = \"user-own\""),
        "same-name user entry untouched"
    );
    assert!(text.contains("[mcp_servers.ccpanes]") && text.contains("enabled = true"));
    assert!(!text.contains("writer-token"));
    let first = text.clone();

    // 幂等：同一集合再同步一次不改文件
    project_mcp::sync_for_launch(&ctx, &GROK, &CcpanesEntry::Http);
    assert_eq!(fs::read_to_string(&config).unwrap(), first);

    // 关掉 MCP：收据里的条目全部移除，用户内容原样
    let mut off = ctx.clone();
    off.skip_mcp = true;
    project_mcp::sync_for_launch(&off, &GROK, &CcpanesEntry::None);
    let text = fs::read_to_string(&config).unwrap();
    assert!(!text.contains("ccpanes") && !text.contains("[mcp_servers.remote]"));
    assert!(text.contains("command = \"user-own\"") && text.contains("# team grok settings"));
}

#[test]
fn git_tracked_targets_are_left_alone_and_written_ones_are_excluded() {
    let root = tempfile::tempdir().unwrap();
    let (repo, data) = (root.path().join("repo"), root.path().join("d"));
    let project = repo.join("app");
    fs::create_dir_all(project.join(".gemini")).unwrap();
    git(&repo, &["init", "-q"]);
    fs::write(project.join(".gemini/settings.json"), "{\"theme\":\"x\"}").unwrap();
    git(&repo, &["add", "."]);
    let ctx = ctx(&project, &data);

    let launch = project_mcp::sync_for_launch(&ctx, &GEMINI, &CcpanesEntry::Http);
    assert!(!launch.active);
    assert_eq!(
        fs::read_to_string(project.join(".gemini/settings.json")).unwrap(),
        "{\"theme\":\"x\"}"
    );

    project_mcp::sync_for_launch(&ctx, &KIMI, &CcpanesEntry::Http);
    let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    assert!(exclude
        .lines()
        .any(|line| line == "/app/.kimi-code/mcp.json"));
    let status = Command::new("git")
        .args(["status", "--porcelain", "--", "app/.kimi-code"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
}

#[test]
fn last_session_out_cleans_the_shared_project_file() {
    let root = tempfile::tempdir().unwrap();
    let (project, data) = (root.path().join("p"), root.path().join("d"));
    fs::create_dir_all(&project).unwrap();
    let first = ctx(&project, &data);
    let mut second = first.clone();
    second.session_id = "writer-session-2".to_string();
    project_mcp::sync_for_launch(&first, &KIMI, &CcpanesEntry::Http);
    project_mcp::sync_for_launch(&second, &KIMI, &CcpanesEntry::Http);
    let target = project.join(".kimi-code/mcp.json");

    project_mcp::release_session(&data, "writer-session-1");
    assert!(
        read_json(&target)["mcpServers"].get("ccpanes").is_some(),
        "second session still running"
    );

    project_mcp::release_session(&data, "writer-session-2");
    assert_eq!(read_json(&target)["mcpServers"], json!({}));
    // 重复释放 / 未知会话是 no-op
    project_mcp::release_session(&data, "writer-session-2");
    project_mcp::release_session(&data, "../escape");
}
