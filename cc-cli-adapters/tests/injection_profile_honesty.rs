//! 诚实守卫（docs/110 §4.3）：`InjectionProfile` 声明支持的每一项，都必须能在
//! `build_command` 产出的 argv / env / 写出（或改动）的文件里找到证据。
//!
//! 「UI 说可用、实际收不到」从此进不了主干：给某个 CLI 的描述加一项支持，却没接上
//! 注入逻辑，这里会直接失败。声明为 None / false 的项不强求证据。
//!
//! 独立的集成测试二进制（独立进程），因此可以安全地把 HOME / CODEX_HOME / GROK_HOME
//! 等指到每个 CLI 各自的临时目录——cursor / grok / pi 原生模式会写用户级文件。
//! 只在 Unix 上跑：Windows 的 `dirs::home_dir()` 不读环境变量，测试会写进真实用户目录。
#![cfg(unix)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cc_cli_adapters::{
    CliAdapterContext, CliToolRegistry, InjectionProfile, McpChannel, McpIsolation, McpTransport,
    RemoteMcpSpec, SkillMount,
};
use serde_json::json;

/// 本文件内的测试共享进程级环境变量，必须串行。
static ENV_LOCK: Mutex<()> = Mutex::new(());

const TOKEN: &str = "guard-token-7f3a";
const LAUNCH_ID: &str = "guard-launch-91c2";
const SHARED_BRIDGE_URL: &str = "http://127.0.0.1:41901/mcp/shared-bridge";
const SHARED_BRIDGE_CMD: &str = "shared-bridge-cmd";
const REMOTE_HTTP_URL: &str = "https://remote-http.guard.example/mcp";
const REMOTE_AUTH_URL: &str = "https://remote-auth.guard.example/mcp";
const REMOTE_HEADER_VALUE: &str = "remote-header-secret-55";
const REMOTE_SSE_URL: &str = "https://remote-sse.guard.example/sse";
const WS_STDIO_CMD: &str = "ws-stdio-cmd";
const WS_HTTP_URL: &str = "https://ws-http.guard.example/mcp";
const USER_ONLY_SERVER: &str = "guard-user-only";
const USER_ONLY_CMD: &str = "guard-user-only-cmd";
const SYSTEM_PROMPT_MARKER: &str = "guard-session-prompt-marker";
const SKILL_BODY_MARKER: &str = "guard-skill-body-marker";

struct Sandbox {
    _root: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    project: PathBuf,
    skill_mount: String,
    proxy_cmd: String,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let data = root.path().join("data");
        let project = root.path().join("project");
        let skill_mount = root.path().join("guard-skill-mount");
        for dir in [&home, &data, &project, &skill_mount] {
            fs::create_dir_all(dir).unwrap();
        }
        seed_skill_mount(&skill_mount);
        let proxy_cmd = root.path().join("bin").join("guard-cc-panes-ctl");
        seed_user_configs(&home);
        // SAFETY 等价：edition 2021 的 set_var 是安全函数；ENV_LOCK 保证本二进制内串行。
        std::env::set_var("HOME", &home);
        std::env::set_var("CODEX_HOME", home.join(".codex"));
        std::env::set_var("GROK_HOME", home.join(".grok"));
        std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
        for key in [
            "OPENCODE_CONFIG",
            "OPENCODE_TUI_CONFIG",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
            "CLAUDE_CONFIG_DIR",
        ] {
            std::env::remove_var(key);
        }
        Self {
            _root: root,
            home,
            data,
            project,
            skill_mount: skill_mount.to_string_lossy().into_owned(),
            proxy_cmd: proxy_cmd.to_string_lossy().into_owned(),
        }
    }

    fn roots(&self) -> [&Path; 3] {
        [&self.home, &self.data, &self.project]
    }
}

/// 挂载根是 Claude 插件布局（与 `<data>/skills/builtin` 一致）：清单 + `skills/<name>/SKILL.md`。
fn seed_skill_mount(root: &Path) {
    let skill = root.join("skills").join("guard-skill");
    fs::create_dir_all(&skill).unwrap();
    fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    fs::write(
        root.join(".claude-plugin").join("plugin.json"),
        "{\"name\":\"guard\"}",
    )
    .unwrap();
    let body = format!("---\nname: guard-skill\ndescription: guard\n---\n{SKILL_BODY_MARKER}\n");
    fs::write(skill.join("SKILL.md"), body).unwrap();
}

/// 用户自己的 MCP（只存在于用户配置里）：完整隔离的证据是「提到它却不启动它」。
fn seed_user_configs(home: &Path) {
    let user_entry = json!({ "mcpServers": { USER_ONLY_SERVER: { "command": USER_ONLY_CMD } } });
    let toml_entry = format!("[mcp_servers.{USER_ONLY_SERVER}]\ncommand = \"{USER_ONLY_CMD}\"\n");
    let writes: [(PathBuf, String); 4] = [
        (home.join(".claude.json"), user_entry.to_string()),
        (
            home.join(".cursor").join("mcp.json"),
            user_entry.to_string(),
        ),
        (home.join(".codex").join("config.toml"), toml_entry.clone()),
        (home.join(".grok").join("config.toml"), toml_entry),
    ];
    for (path, content) in writes {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

fn full_context(sandbox: &Sandbox, cli_id: &str, use_proxy: bool) -> CliAdapterContext {
    let mut adapter_options = HashMap::new();
    if use_proxy {
        adapter_options.insert("mcpProxyEnabled".to_string(), json!(true));
        adapter_options.insert("mcpProxyCommand".to_string(), json!(sandbox.proxy_cmd));
    }
    let shared_mcp_urls = HashMap::from([
        ("shared-bridge".to_string(), SHARED_BRIDGE_URL.to_string()),
        ("remote-http".to_string(), REMOTE_HTTP_URL.to_string()),
        ("remote-auth".to_string(), REMOTE_AUTH_URL.to_string()),
        ("remote-sse".to_string(), REMOTE_SSE_URL.to_string()),
    ]);
    let remote = |transport: &str, headers: BTreeMap<String, String>| RemoteMcpSpec {
        transport: transport.to_string(),
        headers,
    };
    let shared_mcp_remote = BTreeMap::from([
        ("remote-http".to_string(), remote("http", BTreeMap::new())),
        (
            "remote-auth".to_string(),
            remote(
                "http",
                BTreeMap::from([("X-Guard-Key".to_string(), REMOTE_HEADER_VALUE.to_string())]),
            ),
        ),
        ("remote-sse".to_string(), remote("sse", BTreeMap::new())),
    ]);
    let workspace_mcp_servers = BTreeMap::from([
        (
            "ws-stdio".to_string(),
            json!({ "command": WS_STDIO_CMD, "args": [], "env": {} }),
        ),
        (
            "ws-http".to_string(),
            json!({ "type": "http", "url": WS_HTTP_URL }),
        ),
    ]);
    let allowed_mcp_server_ids = ["ccpanes", "shared-bridge", "remote-http", "remote-auth"]
        .into_iter()
        .chain(["remote-sse", "ws-stdio", "ws-http"])
        .map(str::to_string)
        .collect();
    CliAdapterContext {
        session_id: format!("guard-session-{cli_id}"),
        project_path: sandbox.project.to_string_lossy().into_owned(),
        workspace_path: None,
        provider: None,
        executable_override: Some(format!("/ccpanes-guard/bin/{cli_id}")),
        adapter_options,
        resume_id: None,
        issued_session_id: None,
        skip_mcp: false,
        skip_ccpanes_mcp: false,
        yolo_mode: false,
        append_system_prompt: Some(SYSTEM_PROMPT_MARKER.to_string()),
        initial_prompt: None,
        orchestrator_port: Some(41900),
        orchestrator_token: Some(TOKEN.to_string()),
        launch_id: Some(LAUNCH_ID.to_string()),
        data_dir: sandbox.data.clone(),
        shared_mcp_urls,
        shared_mcp_stdio: BTreeMap::from([(
            "shared-bridge".to_string(),
            json!({ "command": SHARED_BRIDGE_CMD, "args": [], "env": {} }),
        )]),
        shared_mcp_remote,
        allowed_mcp_server_ids,
        disable_unlisted_mcp_servers: true,
        skill_mount_paths: vec![sandbox.skill_mount.clone()],
        workspace_mcp_servers,
    }
}

fn snapshot(roots: &[&Path]) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if let Ok(bytes) = fs::read(&path) {
                out.insert(path, bytes);
            }
        }
    }
    let mut out = BTreeMap::new();
    for root in roots {
        walk(root, &mut out);
    }
    out
}

/// 一次 build_command 的全部输出：argv + env + 新写 / 改动过的文件内容。
fn build_corpus(registry: &CliToolRegistry, cli_id: &str, ctx: &CliAdapterContext) -> String {
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let sandbox_roots = [
        Path::new(&ctx.project_path),
        ctx.data_dir.as_path(),
        home.as_path(),
    ];
    let before = snapshot(&sandbox_roots);
    let adapter = registry.get(cli_id).expect("registered adapter");
    let result = adapter
        .build_command(ctx)
        .unwrap_or_else(|error| panic!("{cli_id}: build_command failed: {error:#}"));
    let mut corpus = result.args.join("\n");
    for (key, value) in &result.env_inject {
        corpus.push_str(&format!("\n{key}={value}"));
    }
    for (path, bytes) in snapshot(&sandbox_roots) {
        if before.get(&path) != Some(&bytes) {
            corpus.push_str(&format!("\n--- {}\n", path.display()));
            corpus.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    corpus
}

fn expect(failures: &mut Vec<String>, cli: &str, claim: &str, ok: bool) {
    if !ok {
        failures.push(format!(
            "{cli}: declares {claim} but no evidence in argv/env/files"
        ));
    }
}

fn check_http_pass(failures: &mut Vec<String>, cli: &str, p: &InjectionProfile, corpus: &str) {
    let mcp = &p.mcp;
    if !matches!(mcp.ccpanes, McpChannel::None | McpChannel::StdioProxy) {
        expect(failures, cli, "ccpanes MCP", corpus.contains(TOKEN));
        if mcp.launch_identity {
            let id = format!("launchId={LAUNCH_ID}");
            expect(failures, cli, "launch identity", corpus.contains(&id));
        }
    }
    if mcp.shared && mcp.supports_transport(McpTransport::StdioBridge) {
        let ok = corpus.contains(SHARED_BRIDGE_URL) || corpus.contains(SHARED_BRIDGE_CMD);
        expect(failures, cli, "shared stdio-bridge MCP", ok);
    }
    if mcp.shared && mcp.supports_transport(McpTransport::Http) {
        expect(
            failures,
            cli,
            "remote http MCP",
            corpus.contains(REMOTE_HTTP_URL),
        );
    }
    if mcp.shared && mcp.supports_transport(McpTransport::Sse) {
        expect(
            failures,
            cli,
            "remote sse MCP",
            corpus.contains(REMOTE_SSE_URL),
        );
    }
    if mcp.shared && mcp.remote_headers {
        let ok = corpus.contains(REMOTE_HEADER_VALUE);
        expect(failures, cli, "remote MCP headers", ok);
    }
    if mcp.workspace {
        let ok = corpus.contains(WS_STDIO_CMD) || corpus.contains(WS_HTTP_URL);
        expect(failures, cli, "workspace-layer MCP", ok);
    }
    if mcp.isolation == McpIsolation::Full {
        let ok = corpus.contains(USER_ONLY_SERVER) && !corpus.contains(USER_ONLY_CMD);
        expect(failures, cli, "full MCP isolation", ok);
    }
    if p.skills.mount != SkillMount::None {
        // 直接传挂载路径，或传每会话 staging（其中链接到挂载里的技能正文）。
        let lines: Vec<&str> = corpus.lines().collect();
        let staging_passed = lines
            .windows(2)
            .any(|pair| pair[0].starts_with("--") && pair[1].contains("skill-staging"));
        let staged = staging_passed && corpus.contains(SKILL_BODY_MARKER);
        let ok = corpus.contains("guard-skill-mount") || staged;
        expect(failures, cli, "skill mount", ok);
    }
    if p.skills.prompt_fallback {
        let ok = corpus.contains(SYSTEM_PROMPT_MARKER);
        expect(failures, cli, "skill prompt fallback", ok);
    }
}

fn check_proxy_pass(failures: &mut Vec<String>, cli: &str, p: &InjectionProfile, corpus: &str) {
    expect(
        failures,
        cli,
        "ctl stdio proxy",
        corpus.contains("guard-cc-panes-ctl"),
    );
    if p.mcp.launch_identity {
        let ok = corpus.contains("--launch-id") && corpus.contains(LAUNCH_ID);
        expect(failures, cli, "launch identity via proxy", ok);
    }
}

#[test]
fn every_declared_injection_has_evidence() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let registry = CliToolRegistry::with_builtin_adapters();
    let profiles = registry.injection_profiles();
    assert_eq!(profiles.len(), 11, "new CLI? add it to the honesty guard");
    let mut failures = Vec::new();
    for (cli, profile) in &profiles {
        let sandbox = Sandbox::new();
        let corpus = build_corpus(&registry, cli, &full_context(&sandbox, cli, false));
        check_http_pass(&mut failures, cli, profile, &corpus);
        assert!(sandbox.roots().iter().all(|root| root.exists()));

        if profile.mcp.ctl_proxy {
            let sandbox = Sandbox::new();
            let corpus = build_corpus(&registry, cli, &full_context(&sandbox, cli, true));
            check_proxy_pass(&mut failures, cli, profile, &corpus);
        }
    }
    assert!(
        failures.is_empty(),
        "honesty guard:\n{}",
        failures.join("\n")
    );
}

/// docs/110 批 0：启动档关掉 ccpanes 自身 MCP，不再连带关掉共享与工作空间层。
#[test]
fn skip_ccpanes_mcp_keeps_shared_and_workspace_layers() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let registry = CliToolRegistry::with_builtin_adapters();
    let mut failures = Vec::new();
    for (cli, profile) in registry.injection_profiles() {
        if profile.mcp.ccpanes == McpChannel::None {
            continue;
        }
        for use_proxy in [false, true] {
            let sandbox = Sandbox::new();
            let mut ctx = full_context(&sandbox, &cli, use_proxy);
            ctx.skip_ccpanes_mcp = true;
            let corpus = build_corpus(&registry, &cli, &ctx);
            if corpus.contains(TOKEN) || corpus.contains("guard-cc-panes-ctl") {
                failures.push(format!("{cli} (proxy={use_proxy}): ccpanes still injected"));
            }
            if profile.mcp.shared {
                let ok = corpus.contains(SHARED_BRIDGE_URL) || corpus.contains(SHARED_BRIDGE_CMD);
                if !ok {
                    failures.push(format!("{cli} (proxy={use_proxy}): shared MCP dropped"));
                }
            }
            if profile.mcp.workspace {
                let ok = corpus.contains(WS_STDIO_CMD) || corpus.contains(WS_HTTP_URL);
                if !ok {
                    failures.push(format!("{cli} (proxy={use_proxy}): workspace MCP dropped"));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "skip_ccpanes_mcp:\n{}",
        failures.join("\n")
    );
}
