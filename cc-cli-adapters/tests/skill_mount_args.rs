//! docs/110 批 1：每个 CLI 消费 `skill_mount_paths` 的具体参数形态。
//!
//! 诚实守卫（injection_profile_honesty.rs）只证明「有证据」；这里钉住参数形态本身：
//! 用什么 flag、传挂载根还是 `<根>/skills` 还是单个技能目录、要不要 staging。
//! 独立进程，可以安全改 HOME（kimi 会显式传入用户级默认技能目录）。
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cc_cli_adapters::{CliAdapterContext, CliToolRegistry};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    project: PathBuf,
    builtin: PathBuf,
    workspace: PathBuf,
}

fn plugin(root: &Path, skills: &[&str]) {
    fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    fs::write(root.join(".claude-plugin/plugin.json"), "{}").unwrap();
    for name in skills {
        let dir = root.join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
    }
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let data = root.path().join("data");
        let project = root.path().join("repo").join("app");
        let builtin = root.path().join("builtin");
        let workspace = root.path().join("ws-skills");
        for dir in [&home, &data, &project] {
            fs::create_dir_all(dir).unwrap();
        }
        plugin(&builtin, &["ccpanes-launch-task"]);
        plugin(&workspace, &["team-review"]);
        std::env::set_var("HOME", &home);
        std::env::remove_var("KIMI_CODE_HOME");
        Self {
            _root: root,
            home,
            data,
            project,
            builtin,
            workspace,
        }
    }

    fn ctx(&self) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "mount-session-1".to_string(),
            project_path: self.project.to_string_lossy().into_owned(),
            workspace_path: None,
            provider: None,
            executable_override: Some("/ccpanes-test/bin/cli".to_string()),
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: true,
            skip_ccpanes_mcp: false,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: self.data.clone(),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            shared_mcp_remote: Default::default(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: vec![
                self.builtin.to_string_lossy().into_owned(),
                self.workspace.to_string_lossy().into_owned(),
            ],
            workspace_mcp_servers: Default::default(),
        }
    }

    fn staging(&self) -> PathBuf {
        self.data.join("skill-staging").join("mount-session-1")
    }
}

fn args_for(cli: &str, ctx: &CliAdapterContext) -> Vec<String> {
    let registry = CliToolRegistry::with_builtin_adapters();
    registry
        .get(cli)
        .unwrap()
        .build_command(ctx)
        .unwrap_or_else(|error| panic!("{cli}: {error:#}"))
        .args
}

/// `flag` 后面跟的所有值（按出现顺序）。
fn values_after(args: &[String], flag: &str) -> Vec<String> {
    args.windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
        .collect()
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn plugin_dir_clis_pass_mount_roots_directly() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    for cli in ["grok", "omp"] {
        let args = args_for(cli, &fx.ctx());
        assert_eq!(
            values_after(&args, "--plugin-dir"),
            vec![s(&fx.builtin), s(&fx.workspace)],
            "{cli}"
        );
    }
}

#[test]
fn pi_passes_each_skill_directory_once() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    let args = args_for("pi", &fx.ctx());
    assert_eq!(
        values_after(&args, "--skill"),
        vec![
            s(&fx.builtin.join("skills/ccpanes-launch-task")),
            s(&fx.workspace.join("skills/team-review")),
        ]
    );
}

#[test]
fn kimi_passes_existing_default_dirs_alongside_mounts() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    // 项目根 = 向上最近的含 .git 的目录（不是 project_path 本身）
    let repo = fx.project.parent().unwrap().to_path_buf();
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(repo.join(".agents/skills")).unwrap();
    fs::create_dir_all(fx.home.join(".kimi-code/skills")).unwrap();
    let args = args_for("kimi", &fx.ctx());
    assert_eq!(
        values_after(&args, "--skills-dir"),
        vec![
            s(&repo.join(".agents/skills")),
            s(&fx.home.join(".kimi-code/skills")),
            s(&fx.builtin.join("skills")),
            s(&fx.workspace.join("skills")),
        ]
    );
    // 没有挂载时不传 --skills-dir（否则会关掉 kimi 的自动发现）
    let mut ctx = fx.ctx();
    ctx.skill_mount_paths.clear();
    assert!(values_after(&args_for("kimi", &ctx), "--skills-dir").is_empty());
}

#[test]
fn cursor_and_antigravity_receive_a_per_session_staging_dir() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    let staging = fx.staging();

    let cursor = args_for("cursor", &fx.ctx());
    assert_eq!(values_after(&cursor, "--plugin-dir"), vec![s(&staging)]);
    assert!(staging.join(".cursor-plugin/plugin.json").is_file());
    assert!(staging
        .join("skills/ccpanes-launch-task/SKILL.md")
        .is_file());
    assert!(staging.join("skills/team-review/SKILL.md").is_file());

    let agy = args_for("antigravity", &fx.ctx());
    assert_eq!(values_after(&agy, "--add-dir"), vec![s(&staging)]);
    assert!(staging
        .join(".agents/skills/team-review/SKILL.md")
        .is_file());
}

#[test]
fn opencode_lists_skill_roots_in_the_session_config() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    std::env::set_var("XDG_CONFIG_HOME", fx.home.join(".config"));
    std::env::remove_var("OPENCODE_CONFIG");
    std::env::remove_var("OPENCODE_TUI_CONFIG");
    let registry = CliToolRegistry::with_builtin_adapters();
    let result = registry
        .get("opencode")
        .unwrap()
        .build_command(&fx.ctx())
        .unwrap();
    let config_path = result
        .env_inject
        .get("OPENCODE_CONFIG")
        .expect("session config");
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
    assert_eq!(
        config["skills"]["paths"],
        serde_json::json!([
            s(&fx.builtin.join("skills")),
            s(&fx.workspace.join("skills"))
        ])
    );
}

#[test]
fn clis_without_a_mount_channel_ignore_mount_paths() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fixture::new();
    for cli in ["jcode", "gemini"] {
        let args = args_for(cli, &fx.ctx());
        let joined = args.join(" ");
        assert!(!joined.contains("builtin"), "{cli}: {joined}");
        assert!(!fx.staging().exists(), "{cli} must not stage");
    }
}
