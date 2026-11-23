//! docs/110 §7 #1：Codex 技能链接进项目 `.agents/skills/` 的生命周期——
//! 收据（只删我们的、仍原样的）、精确 exclude、会话租约引用计数、目录回收。
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use cc_cli_adapters::project_skills::{
    project_skills_dir, receipt_path, release_session, sync_for_launch,
};
use cc_cli_adapters::{CliAdapterContext, CliToolRegistry};

/// codex 的 build_command 读 HOME / CODEX_HOME，串行并指到临时目录。
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Fx {
    _root: tempfile::TempDir,
    data: PathBuf,
    project: PathBuf,
    mount: String,
    other_mount: String,
}

fn plugin(root: &Path, skills: &[&str]) -> String {
    for name in skills {
        let dir = root.join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
    }
    root.to_string_lossy().into_owned()
}

fn git(project: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(project)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

impl Fx {
    fn new(git_repo: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        if git_repo {
            git(&project, &["init", "-q", "."]);
        }
        let mount = plugin(&root.path().join("builtin"), &["ccpanes-a", "ccpanes-b"]);
        let other_mount = plugin(&root.path().join("ws"), &["team-c"]);
        Self {
            _root: root,
            data,
            project,
            mount,
            other_mount,
        }
    }

    fn sync(&self, session: &str, mounts: &[String]) -> Vec<String> {
        sync_for_launch("codex", &self.data, session, &self.project, mounts).linked
    }

    fn link(&self, name: &str) -> PathBuf {
        project_skills_dir(&self.project).join(name)
    }

    fn exclude(&self) -> String {
        fs::read_to_string(self.project.join(".git/info/exclude")).unwrap_or_default()
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

#[test]
fn links_are_created_excluded_and_fully_cleaned_after_the_last_session() {
    let fx = Fx::new(true);
    let before_exclude = fx.exclude();
    let linked = fx.sync("s1", &[fx.mount.clone()]);
    assert_eq!(linked, vec!["ccpanes-a", "ccpanes-b"]);
    assert!(is_symlink(&fx.link("ccpanes-a")));
    assert!(fx.link("ccpanes-a/SKILL.md").is_file());
    let exclude = fx.exclude();
    assert!(exclude.contains("/.agents/skills/ccpanes-a\n"));
    assert!(!exclude.lines().any(|line| line.trim() == "/.agents"));
    // 精确排除生效：git 看不到链接
    let status = Command::new("git")
        .args(["status", "--porcelain", "--", ".agents"])
        .current_dir(&fx.project)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());

    release_session(&fx.data, "s1");
    assert!(!fx.project.join(".agents").exists(), "created dirs removed");
    assert!(!receipt_path(&fx.project, "codex").exists());
    assert_eq!(fx.exclude(), before_exclude, "our exclude lines removed");
    // 来源完好
    assert!(Path::new(&fx.mount)
        .join("skills/ccpanes-a/SKILL.md")
        .is_file());
}

#[test]
fn user_owned_and_tracked_names_are_never_touched() {
    let fx = Fx::new(true);
    let user_dir = fx.link("ccpanes-a");
    fs::create_dir_all(&user_dir).unwrap();
    fs::write(user_dir.join("SKILL.md"), "mine").unwrap();
    let tracked = fx.link("ccpanes-b");
    fs::create_dir_all(&tracked).unwrap();
    fs::write(tracked.join("SKILL.md"), "committed").unwrap();
    git(&fx.project, &["add", ".agents/skills/ccpanes-b"]);
    fs::remove_dir_all(&tracked).unwrap(); // 跟踪中但工作区删了，也不能写

    let outcome = sync_for_launch("codex", &fx.data, "s1", &fx.project, &[fx.mount.clone()]);
    assert!(outcome.linked.is_empty());
    assert_eq!(outcome.skipped, vec!["ccpanes-a", "ccpanes-b"]);
    assert_eq!(
        fs::read_to_string(user_dir.join("SKILL.md")).unwrap(),
        "mine"
    );
    assert!(!tracked.exists());
    assert!(!fx.exclude().contains("ccpanes-a"));

    release_session(&fx.data, "s1");
    assert_eq!(
        fs::read_to_string(user_dir.join("SKILL.md")).unwrap(),
        "mine"
    );
}

#[test]
fn concurrent_sessions_share_links_by_lease() {
    let fx = Fx::new(false);
    fs::create_dir_all(fx.project.join(".agents")).unwrap(); // 用户自己的 .agents
    fx.sync("s1", &[fx.mount.clone()]);
    fx.sync("s2", &[fx.mount.clone(), fx.other_mount.clone()]);
    assert!(is_symlink(&fx.link("team-c")));

    release_session(&fx.data, "s2");
    assert!(is_symlink(&fx.link("ccpanes-a")), "s1 still needs it");
    assert!(!fx.link("team-c").exists(), "only s2 wanted team-c");

    release_session(&fx.data, "s1");
    assert!(!project_skills_dir(&fx.project).exists());
    assert!(fx.project.join(".agents").is_dir(), "user's dir stays");
    release_session(&fx.data, "s1"); // 重复释放无副作用
}

#[test]
fn replaced_links_are_left_alone_on_cleanup() {
    let fx = Fx::new(false);
    fx.sync("s1", &[fx.mount.clone()]);
    // 用户把我们的链接换成了自己的目录
    fs::remove_file(fx.link("ccpanes-a")).unwrap();
    fs::create_dir_all(fx.link("ccpanes-a")).unwrap();
    fs::write(fx.link("ccpanes-a/SKILL.md"), "mine").unwrap();
    // 再把另一个换成指向别处的链接
    fs::remove_file(fx.link("ccpanes-b")).unwrap();
    std::os::unix::fs::symlink(&fx.other_mount, fx.link("ccpanes-b")).unwrap();

    release_session(&fx.data, "s1");
    assert_eq!(
        fs::read_to_string(fx.link("ccpanes-a/SKILL.md")).unwrap(),
        "mine"
    );
    assert!(is_symlink(&fx.link("ccpanes-b")));
    assert!(
        fx.project.join(".agents/skills").is_dir(),
        "not empty, kept"
    );
}

#[test]
fn stale_leases_from_crashed_sessions_do_not_block_cleanup_forever() {
    let fx = Fx::new(false);
    fx.sync("crashed", &[fx.mount.clone()]);
    fx.sync("s2", &[fx.mount.clone()]);
    // 崩溃会话的租约超过 TTL（把 mtime 拨回 8 天前）
    let lease = fx
        .data
        .join("cli-adapters/project-skill-leases/crashed.json");
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 3600);
    fs::File::options()
        .write(true)
        .open(&lease)
        .unwrap()
        .set_modified(old)
        .unwrap();
    release_session(&fx.data, "s2");
    assert!(!fx.project.join(".agents").exists());
}

#[test]
fn corrupt_receipt_treats_everything_as_user_owned() {
    let fx = Fx::new(false);
    fx.sync("s1", &[fx.mount.clone()]);
    fs::write(receipt_path(&fx.project, "codex"), "{not json").unwrap();
    release_session(&fx.data, "s1");
    assert!(is_symlink(&fx.link("ccpanes-a")), "unknown ownership: keep");
}

fn codex_ctx(fx: &Fx, mounts: Vec<String>) -> CliAdapterContext {
    CliAdapterContext {
        session_id: "codex-session-1".to_string(),
        project_path: fx.project.to_string_lossy().into_owned(),
        workspace_path: None,
        provider: None,
        executable_override: Some("/ccpanes-test/bin/codex".to_string()),
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
        data_dir: fx.data.clone(),
        shared_mcp_urls: HashMap::new(),
        shared_mcp_stdio: Default::default(),
        shared_mcp_remote: Default::default(),
        allowed_mcp_server_ids: Vec::new(),
        disable_unlisted_mcp_servers: false,
        skill_mount_paths: mounts,
        workspace_mcp_servers: Default::default(),
    }
}

#[test]
fn codex_build_command_links_skills_instead_of_passing_skills_config() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fx = Fx::new(false);
    let home = fx.data.join("home");
    fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("CODEX_HOME", home.join(".codex"));
    let registry = CliToolRegistry::with_builtin_adapters();
    let codex = registry.get("codex").unwrap();

    let args = codex
        .build_command(&codex_ctx(
            &fx,
            vec![fx.mount.clone(), fx.other_mount.clone()],
        ))
        .unwrap()
        .args;
    assert!(!args.iter().any(|arg| arg.contains("skills.config")));
    assert!(is_symlink(&fx.link("ccpanes-a")));
    assert!(is_symlink(&fx.link("team-c")));
    assert!(
        !home.join(".codex/skills").exists(),
        "never writes ~/.codex"
    );

    // 关掉技能的会话什么都不碰
    let mut ctx = codex_ctx(&fx, Vec::new());
    ctx.session_id = "codex-session-2".to_string();
    codex.build_command(&ctx).unwrap();
    assert!(!fx
        .data
        .join("cli-adapters/project-skill-leases/codex-session-2.json")
        .exists());

    release_session(&fx.data, "codex-session-1");
    assert!(!fx.project.join(".agents").exists());
}
