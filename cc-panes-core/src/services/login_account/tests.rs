use super::*;
use crate::models::provider::{
    login_dir_env_var, ProviderType, DEFAULT_ACCOUNT_ID, LOGIN_CLI_TOOLS,
};
use std::sync::Mutex;
use tempfile::TempDir;

/// 钥匙串替身：只回答「在 / 不在 / 查不了」，并记下被查过的条目名。
#[derive(Default)]
struct FakeKeychain {
    existing: Vec<String>,
    unavailable: bool,
    queries: Mutex<Vec<String>>,
}

impl KeychainProbe for FakeKeychain {
    fn item_exists(&self, service: &str, account: Option<&str>) -> Option<bool> {
        let key = match account {
            Some(account) => format!("{service}/{account}"),
            None => service.to_string(),
        };
        self.queries.lock().unwrap().push(key.clone());
        (!self.unavailable).then(|| self.existing.contains(&key))
    }
}

struct Fixture {
    _temp: TempDir,
    home: PathBuf,
    root: PathBuf,
    providers: Arc<ProviderService>,
    service: LoginAccountService,
}

fn provider_type_for(cli: &str) -> ProviderType {
    match cli {
        "claude" => ProviderType::Anthropic,
        "codex" => ProviderType::OpenAI,
        "gemini" | "antigravity" => ProviderType::Gemini,
        "grok" => ProviderType::Grok,
        other => panic!("no provider type for {other}"),
    }
}

fn fixture_with(keychain: FakeKeychain) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    // 规范化：macOS 的临时目录在 /var → /private/var 的链接后面。
    let base = fs::canonicalize(temp.path()).unwrap();
    let home = base.join("home");
    let data = base.join("data");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&data).unwrap();
    let providers = Arc::new(ProviderService::new(data.join("providers.json")));
    for cli in ["claude", "codex", "gemini", "grok"] {
        providers
            .add_provider(Provider {
                id: format!("p-{cli}"),
                name: format!("Provider {cli}"),
                provider_type: provider_type_for(cli),
                api_key: Some("sk-existing-key".to_string()),
                ..Provider::default()
            })
            .unwrap();
    }
    let root = data.join("login-accounts");
    let host = LoginHost {
        home: Some(home.clone()),
        dir_env: HashMap::new(),
        keychain: Arc::new(keychain),
        resolve_executable: |name| Some(PathBuf::from(format!("/fake/bin/{name}"))),
    };
    let service = LoginAccountService::with_host(providers.clone(), root.clone(), host);
    Fixture {
        _temp: temp,
        home,
        root,
        providers,
        service,
    }
}

fn fixture() -> Fixture {
    fixture_with(FakeKeychain::default())
}

fn provider_id_for(cli: &str) -> String {
    match cli {
        "antigravity" => "p-gemini".to_string(),
        other => format!("p-{other}"),
    }
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn create(fixture: &Fixture, cli: &str, name: &str) -> LoginAccountView {
    fixture
        .service
        .create_login_account(
            &provider_id_for(cli),
            CreateLoginAccountRequest {
                cli_tool: cli.to_string(),
                name: name.to_string(),
                color: Some("#3b82f6".to_string()),
            },
        )
        .unwrap()
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// 在模拟的默认目录里放上每个 CLI 的设置 / 技能 / 指令文件，以及凭据和会话历史。
fn seed_default_dirs(home: &Path) {
    // Claude
    write(&home.join(".claude/settings.json"), "{}");
    write(&home.join(".claude/CLAUDE.md"), "rules");
    write(&home.join(".claude/skills/a/SKILL.md"), "skill");
    write(&home.join(".claude/commands/x.md"), "cmd");
    write(&home.join(".claude/.credentials.json"), "SECRET");
    write(&home.join(".claude/projects/p/s.jsonl"), "{}");
    write(&home.join(".claude/history.jsonl"), "{}");
    // Codex
    write(&home.join(".codex/config.toml"), "model = \"gpt-5\"\n");
    write(&home.join(".codex/AGENTS.md"), "rules");
    write(&home.join(".codex/skills/a/SKILL.md"), "skill");
    write(&home.join(".codex/auth.json"), "SECRET");
    write(
        &home.join(".codex/sessions/2026/11/21/rollout-x.jsonl"),
        "{}",
    );
    write(&home.join(".codex/history.jsonl"), "{}");
    // Gemini CLI 与 Antigravity 共用 ~/.gemini
    write(&home.join(".gemini/settings.json"), "{}");
    write(&home.join(".gemini/GEMINI.md"), "rules");
    write(&home.join(".gemini/skills/a/SKILL.md"), "skill");
    write(&home.join(".gemini/oauth_creds.json"), "SECRET");
    write(&home.join(".gemini/google_accounts.json"), "{}");
    write(&home.join(".gemini/tmp/x/chat.json"), "{}");
    write(&home.join(".gemini/AGENTS.md"), "rules");
    write(&home.join(".gemini/config/skills.json"), "{}");
    write(&home.join(".gemini/config/skills/a/SKILL.md"), "skill");
    write(
        &home.join(".gemini/antigravity-cli/skills/a/SKILL.md"),
        "skill",
    );
    write(&home.join(".agents/skills/a/SKILL.md"), "skill");
    // Grok
    write(&home.join(".grok/config.toml"), "x = 1\n");
    write(&home.join(".grok/AGENTS.md"), "rules");
    write(&home.join(".grok/skills/a/SKILL.md"), "skill");
    write(&home.join(".grok/auth.json"), "SECRET");
    write(&home.join(".grok/sessions/s.jsonl"), "{}");
    write(&home.join(".grok/bin/grok"), "binary");
}

/// 五个 CLI 各自建账号目录：路径在账号目录根下、目录名就是账号 id、不含用户输入的名字；
/// 设置 / 技能 / 指令文件链接回默认目录；凭据和会话历史一个都不共享。
#[cfg(unix)]
#[test]
fn each_cli_gets_a_private_dir_with_shared_settings_and_isolated_credentials() {
    let fixture = fixture();
    seed_default_dirs(&fixture.home);
    // (cli, 应链接的条目, 绝不能出现在账号目录里的条目)
    let cases: [(&str, &[&str], &[&str]); 5] = [
        (
            "claude",
            &["settings.json", "CLAUDE.md", "skills", "commands"],
            &[
                ".credentials.json",
                "projects",
                "history.jsonl",
                ".claude.json",
            ],
        ),
        (
            "codex",
            &["config.toml", "AGENTS.md", "skills"],
            &["auth.json", "sessions", "history.jsonl"],
        ),
        (
            "gemini",
            &[
                ".gemini/settings.json",
                ".gemini/GEMINI.md",
                ".gemini/skills",
                ".agents/skills",
            ],
            &[
                ".gemini/oauth_creds.json",
                ".gemini/google_accounts.json",
                ".gemini/tmp",
            ],
        ),
        (
            "antigravity",
            &[
                "AGENTS.md",
                "GEMINI.md",
                "config/skills.json",
                "config/skills",
                "antigravity-cli/skills",
            ],
            &[
                "oauth_creds.json",
                "google_accounts.json",
                "tmp",
                "settings.json",
            ],
        ),
        (
            "grok",
            &["config.toml", "AGENTS.md", "skills"],
            &["auth.json", "sessions", "bin"],
        ),
    ];

    for (cli, linked, absent) in cases {
        let view = create(&fixture, cli, &format!("个人号 / ../x {cli}"));
        let dir = PathBuf::from(view.config_dir.clone().unwrap());

        assert_eq!(dir.parent(), Some(fixture.root.as_path()), "{cli}");
        assert_eq!(
            dir.file_name().unwrap().to_str(),
            Some(view.account_id.as_str())
        );
        assert!(view.account_id.starts_with(&format!("{cli}-")), "{cli}");
        assert!(
            !dir.to_string_lossy().contains("个人号"),
            "the account dir must not contain the user-entered name"
        );
        assert!(view.dir_managed && view.dir_exists && !view.is_default_login);
        assert_eq!(view.cli_tool, cli);

        let layout = layout_for(cli).unwrap();
        let default_dir = layout.default_dir(&fixture.home, None);
        for rel in linked {
            let target = dir.join(rel);
            assert!(is_symlink(&target), "{cli}: {rel} should be a link");
            assert_eq!(
                fs::canonicalize(&target).unwrap(),
                fs::canonicalize(default_dir.join(rel)).unwrap(),
                "{cli}: {rel}"
            );
        }
        for rel in absent {
            assert!(
                fs::symlink_metadata(dir.join(rel)).is_err(),
                "{cli}: {rel} must not be shared into the account dir"
            );
        }
        // 账号目录里除了链接和标记文件，没有任何从默认目录带过来的真实内容。
        assert!(dir.join(ACCOUNT_MARKER_FILE).is_file());

        // 登记成了该供应商下的登录账号，解析出的环境变量带对目录变量。
        let provider = fixture
            .providers
            .get_provider(&provider_id_for(cli))
            .unwrap();
        let env = fixture
            .providers
            .resolve_launch_env(&provider, Some(&view.account_id), cli)
            .unwrap();
        assert_eq!(
            env.env_map().get(login_dir_env_var(cli).unwrap()),
            Some(&dir.to_string_lossy().into_owned())
        );
        assert_eq!(env.api_key, None, "{cli}: a login account carries no key");
    }
}

/// 默认目录里没有的文件不凭空创建。
#[test]
fn entries_missing_from_the_default_dir_are_not_created() {
    let fixture = fixture();
    write(&fixture.home.join(".codex/config.toml"), "x = 1\n");

    let view = create(&fixture, "codex", "work");
    let dir = PathBuf::from(view.config_dir.unwrap());

    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec![ACCOUNT_MARKER_FILE, "config.toml"]);
}

/// 在新账号里登录（CLI 往账号目录写凭据和会话）不会碰到默认目录里的凭据。
#[cfg(unix)]
#[test]
fn signing_in_inside_an_account_dir_never_touches_default_credentials() {
    let fixture = fixture();
    seed_default_dirs(&fixture.home);
    let view = create(&fixture, "codex", "work");
    let dir = PathBuf::from(view.config_dir.unwrap());

    // 模拟 CLI 登录后写下凭据和会话。
    write(&dir.join("auth.json"), "ACCOUNT-SECRET");
    write(&dir.join("sessions/2026/11/21/rollout-y.jsonl"), "{}");

    assert_eq!(
        fs::read_to_string(fixture.home.join(".codex/auth.json")).unwrap(),
        "SECRET"
    );
    assert!(!fixture
        .home
        .join(".codex/sessions/2026/11/21/rollout-y.jsonl")
        .exists());
    // 反过来，默认目录的凭据也不出现在账号目录里。
    assert_eq!(
        fs::read_to_string(dir.join("auth.json")).unwrap(),
        "ACCOUNT-SECRET"
    );
}

/// 启动前补链接：默认目录里后来才出现的文件补进来；账号里已有的真实内容不动；
/// CLI 留下的空目录占位换成链接。
#[cfg(unix)]
#[test]
fn refresh_adds_new_shared_entries_and_keeps_account_local_content() {
    let fixture = fixture();
    write(&fixture.home.join(".claude/settings.json"), "{}");
    let view = create(&fixture, "claude", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());
    assert!(fs::symlink_metadata(dir.join("CLAUDE.md")).is_err());

    // 之后：默认目录多了指令文件和技能；账号里 CLI 建了空的 skills 占位、自己写了 commands。
    write(&fixture.home.join(".claude/CLAUDE.md"), "rules");
    write(&fixture.home.join(".claude/skills/a/SKILL.md"), "skill");
    write(&fixture.home.join(".claude/commands/shared.md"), "shared");
    fs::create_dir_all(dir.join("skills")).unwrap();
    write(&dir.join("commands/mine.md"), "mine");

    fixture
        .service
        .refresh_links_for_launch("claude", view.config_dir.as_deref().unwrap());

    assert!(is_symlink(&dir.join("CLAUDE.md")));
    assert!(is_symlink(&dir.join("skills")));
    assert!(!is_symlink(&dir.join("commands")));
    assert!(dir.join("commands/mine.md").is_file());
    assert!(!dir.join("commands/shared.md").exists());
}

/// 用户手填的外部目录：启动前不往里链接任何东西。
#[test]
fn external_dirs_are_never_linked_into() {
    let fixture = fixture();
    write(&fixture.home.join(".claude/settings.json"), "{}");
    let external = fixture.home.join("my-claude");
    fs::create_dir_all(&external).unwrap();

    fixture
        .service
        .refresh_links_for_launch("claude", &external.to_string_lossy());

    assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
}

#[test]
fn duplicate_names_reserved_names_and_incompatible_clis_are_rejected() {
    let fixture = fixture();
    create(&fixture, "claude", "工作号");

    let again = |cli: &str, provider: &str, name: &str| {
        fixture
            .service
            .create_login_account(
                provider,
                CreateLoginAccountRequest {
                    cli_tool: cli.to_string(),
                    name: name.to_string(),
                    color: None,
                },
            )
            .unwrap_err()
    };
    assert_eq!(
        again("claude", "p-claude", " 工作号 ").code(),
        Some("PROVIDER_ACCOUNT_NAME_EXISTS")
    );
    assert_eq!(
        again("claude", "p-claude", "默认登录").code(),
        Some("PROVIDER_ACCOUNT_NAME_EXISTS")
    );
    assert_eq!(
        again("claude", "p-claude", "   ").code(),
        Some("PROVIDER_ACCOUNT_NAME_INVALID")
    );
    // Codex 的登录不能挂在 Anthropic 类型的供应商下。
    assert_eq!(
        again("codex", "p-claude", "x").code(),
        Some("LOGIN_ACCOUNT_CLI_INCOMPATIBLE")
    );
    assert_eq!(
        again("kimi", "p-claude", "x").code(),
        Some("LOGIN_ACCOUNT_CLI_UNSUPPORTED")
    );
    assert_eq!(
        again("claude", "missing", "x").code(),
        Some("PROVIDER_NOT_FOUND")
    );
    // 被拒绝的请求不留下孤儿目录：根下只有第一次建的那个。
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
}

/// 机器上原有的登录表现为合成的「默认登录」：不建目录、不带目录变量、不落盘。
#[test]
fn default_login_is_synthesized_without_dir_or_dir_variable() {
    let fixture = fixture();
    let before = fs::read_to_string(fixture.root.parent().unwrap().join("providers.json")).unwrap();

    for cli in LOGIN_CLI_TOOLS {
        let provider_id = provider_id_for(cli);
        let views = fixture.service.list_login_accounts(&provider_id).unwrap();
        let default = views
            .iter()
            .find(|view| view.cli_tool == cli && view.is_default_login)
            .unwrap_or_else(|| panic!("{cli} has no default login"));
        assert_eq!(default.account_id, DEFAULT_LOGIN_ACCOUNT_ID);
        assert_eq!(default.name, "默认登录");
        assert_eq!(default.config_dir, None);
        assert!(!default.dir_managed);

        let provider = fixture.providers.get_provider(&provider_id).unwrap();
        let env = fixture
            .providers
            .resolve_launch_env(&provider, Some(DEFAULT_LOGIN_ACCOUNT_ID), cli)
            .unwrap();
        let vars = env.env_map();
        assert!(!vars.contains_key(login_dir_env_var(cli).unwrap()), "{cli}");
        assert!(!vars.contains_key("SSH_CONNECTION"), "{cli}");
        assert_eq!(env.api_key, None, "{cli}: default login carries no key");
        assert_eq!(env.config_dir, None);
    }

    // 什么都没落盘，也没建目录；旧的默认账号照旧。
    assert!(!fixture.root.exists());
    assert_eq!(
        fs::read_to_string(fixture.root.parent().unwrap().join("providers.json")).unwrap(),
        before
    );
    let provider = fixture.providers.get_provider("p-claude").unwrap();
    assert_eq!(provider.accounts.len(), 1);
    assert_eq!(provider.default_account().unwrap().id, DEFAULT_ACCOUNT_ID);
    assert!(!before.contains(DEFAULT_LOGIN_ACCOUNT_ID));

    // 默认登录不能删。
    let error = fixture
        .service
        .delete_account("p-claude", DEFAULT_LOGIN_ACCOUNT_ID, true)
        .unwrap_err();
    assert_eq!(error.code(), Some("LOGIN_ACCOUNT_DEFAULT_UNDELETABLE"));
}

#[test]
fn login_commands_follow_each_cli() {
    let fixture = fixture();
    // (cli, 参数, 是否要用户在 CLI 里自己选登录方式)
    let cases: [(&str, &[&str], bool); 5] = [
        ("claude", &["auth", "login"], false),
        ("codex", &["login"], false),
        ("gemini", &[], true),
        ("antigravity", &["acp", "--login"], false),
        ("grok", &["login"], false),
    ];
    for (cli, args, interactive) in cases {
        let view = create(&fixture, cli, &format!("{cli} 第二个号"));
        let command = fixture
            .service
            .login_command(&provider_id_for(cli), &view.account_id, None, &|_| None)
            .unwrap();

        let layout = layout_for(cli).unwrap();
        assert_eq!(command.cli_tool, cli);
        assert_eq!(command.command, format!("/fake/bin/{}", layout.executable));
        assert!(command.executable_found);
        let mut expected: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        if cli == "antigravity" {
            // agy 不读 GEMINI_HOME：账号目录经 `acp --gemini_dir <目录>` 传。
            expected.splice(
                1..1,
                ["--gemini_dir".to_string(), view.config_dir.clone().unwrap()],
            );
        }
        assert_eq!(command.args, expected, "{cli}");
        assert_eq!(command.interactive, interactive, "{cli}");
        assert_eq!(
            command.env.get(layout.dir_env_var),
            view.config_dir.as_ref(),
            "{cli}"
        );
        // 只有 Antigravity 需要「以为自己在远程连接里」的绕法。
        assert_eq!(
            command.env.get("SSH_CONNECTION").map(String::as_str),
            (cli == "antigravity").then_some("127.0.0.1 0 127.0.0.1 0"),
            "{cli}"
        );
        // Gemini CLI 显式关掉「凭据进钥匙串」（那个条目不分目录）。
        assert_eq!(
            command
                .env
                .get("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE")
                .map(String::as_str),
            (cli == "gemini").then_some("false"),
            "{cli}"
        );
        let extra = usize::from(matches!(cli, "antigravity" | "gemini"));
        assert_eq!(command.env.len(), 1 + extra);
        // 启动时注入的环境与登录时一致：同一个目录、同一套隔离变量。
        let provider = fixture
            .providers
            .get_provider(&provider_id_for(cli))
            .unwrap();
        let launch_env = fixture
            .providers
            .resolve_launch_env(&provider, Some(&view.account_id), cli)
            .unwrap()
            .env_map();
        for (name, value) in &command.env {
            assert_eq!(launch_env.get(name), Some(value), "{cli}: {name}");
        }
    }

    // 默认登录：同样的命令，但不带目录变量（登录进 CLI 的默认目录）。
    let command = fixture
        .service
        .login_command(
            "p-gemini",
            DEFAULT_LOGIN_ACCOUNT_ID,
            Some("antigravity"),
            &|_| None,
        )
        .unwrap();
    assert_eq!(command.cli_tool, "antigravity");
    assert_eq!(command.args, vec!["acp", "--login"]);
    assert!(command.env.is_empty());

    // 用户在设置里配了启动命令：照用。
    let view = create(&fixture, "claude", "override");
    let command = fixture
        .service
        .login_command("p-claude", &view.account_id, None, &|cli| {
            (cli == "claude").then(|| " /opt/claude ".to_string())
        })
        .unwrap();
    assert_eq!(command.command, "/opt/claude");

    // 密钥账号没有登录命令。
    let error = fixture
        .service
        .login_command("p-claude", DEFAULT_ACCOUNT_ID, None, &|_| None)
        .unwrap_err();
    assert_eq!(error.code(), Some("PROVIDER_ACCOUNT_NOT_LOGIN"));
}

/// 找不到可执行文件时退回裸名字，并如实标出来。
#[test]
fn login_command_reports_a_missing_executable() {
    let mut fixture = fixture();
    fixture.service.host.resolve_executable = |_| None;
    let view = create(&fixture, "grok", "second");

    let command = fixture
        .service
        .login_command("p-grok", &view.account_id, None, &|_| None)
        .unwrap();

    assert_eq!(command.command, "grok");
    assert!(!command.executable_found);
}

fn id_token(email: &str) -> String {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!(
        "{}.{}.signature-part",
        engine.encode(r#"{"alg":"none"}"#),
        engine.encode(format!(r#"{{"email":"{email}","sub":"u1"}}"#))
    )
}

#[test]
fn claude_status_reads_email_and_checks_only_whether_the_keychain_item_exists() {
    let probe = FakeKeychain::default();
    let mut fixture = fixture_with(probe);
    let view = create(&fixture, "claude", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());

    // 没登录：钥匙串里没有条目，目录里也没有凭据文件。
    assert_eq!(view.status.state, LoginState::NotLoggedIn);
    assert_eq!(view.status.identity, None);

    // 已登录：钥匙串条目名带着目录路径的哈希，邮箱来自 `<目录>/.claude.json`。
    let service_name = claude_keychain_service(Some(&dir.to_string_lossy()));
    assert!(service_name.starts_with("Claude Code-credentials-"));
    assert_eq!(service_name.len(), "Claude Code-credentials-".len() + 8);
    write(
        &dir.join(".claude.json"),
        r#"{"oauthAccount":{"emailAddress":"work@example.com","accountUuid":"u"},"projects":{}}"#,
    );
    fixture.service.host.keychain = Arc::new(FakeKeychain {
        existing: vec![service_name.clone()],
        ..FakeKeychain::default()
    });
    let status = fixture
        .service
        .login_status("p-claude", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity.as_deref(), Some("work@example.com"));
    assert_eq!(status.credential_source.as_deref(), Some("keychain"));

    // 凭据在目录里的文件（Linux / Windows）：只看文件在不在。
    fixture.service.host.keychain = Arc::new(FakeKeychain::default());
    write(
        &dir.join(".credentials.json"),
        "not even json — never parsed",
    );
    let status = fixture
        .service
        .login_status("p-claude", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.credential_source.as_deref(), Some("file"));

    // 默认登录查的是不带后缀的条目和 ~/.claude.json。
    write(
        &fixture.home.join(".claude.json"),
        r#"{"oauthAccount":{"emailAddress":"default@example.com"}}"#,
    );
    fixture.service.host.keychain = Arc::new(FakeKeychain {
        existing: vec!["Claude Code-credentials".to_string()],
        ..FakeKeychain::default()
    });
    let status = fixture
        .service
        .login_status("p-claude", DEFAULT_LOGIN_ACCOUNT_ID, Some("claude"))
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity.as_deref(), Some("default@example.com"));

    // 「CLI 自带登录」不依赖任何供应商：系统 id 查到的是同一个默认目录。
    let system = fixture
        .service
        .login_status(
            crate::models::provider::SYSTEM_PROVIDER_ID,
            DEFAULT_LOGIN_ACCOUNT_ID,
            Some("claude"),
        )
        .unwrap();
    assert_eq!(system, status);
    assert!(fixture
        .service
        .login_status(
            crate::models::provider::SYSTEM_PROVIDER_ID,
            DEFAULT_LOGIN_ACCOUNT_ID,
            Some("kimi"),
        )
        .is_err());
}

/// 钥匙串查不了（锁着 / 被拒）：未知，不猜。
#[cfg(target_os = "macos")]
#[test]
fn status_is_unknown_when_the_keychain_cannot_be_queried() {
    let fixture = fixture_with(FakeKeychain {
        unavailable: true,
        ..FakeKeychain::default()
    });
    for cli in ["claude", "codex"] {
        let view = create(&fixture, cli, "work");
        assert_eq!(view.status.state, LoginState::Unknown, "{cli}");
        assert_eq!(view.status.reason.as_deref(), Some("keychain_unavailable"));
    }
}

#[test]
fn codex_status_takes_the_email_claim_and_keeps_no_token() {
    let fixture = fixture();
    let view = create(&fixture, "codex", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());
    assert_eq!(view.status.state, LoginState::NotLoggedIn);

    let token = id_token("codex@example.com");
    write(
        &dir.join("auth.json"),
        &format!(
            r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"{token}","access_token":"ACCESS-SECRET","refresh_token":"REFRESH-SECRET"}},"last_refresh":"2026-11-21T00:00:00Z"}}"#
        ),
    );
    let status = fixture
        .service
        .login_status("p-codex", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity.as_deref(), Some("codex@example.com"));
    // 返回给界面的内容里没有任何令牌。
    let json = serde_json::to_string(&status).unwrap();
    for secret in [
        "ACCESS-SECRET",
        "REFRESH-SECRET",
        token.as_str(),
        "signature-part",
    ] {
        assert!(!json.contains(secret), "status leaked {secret}");
    }

    // 文件在但读不出邮箱（API key 登录 / 格式变了）：已登录，身份未知。
    write(&dir.join("auth.json"), r#"{"OPENAI_API_KEY":"sk-x"}"#);
    let status = fixture
        .service
        .login_status("p-codex", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity, None);
    assert!(!serde_json::to_string(&status).unwrap().contains("sk-x"));
}

#[test]
fn codex_keychain_login_is_detected_by_item_name_only() {
    let mut fixture = fixture();
    let view = create(&fixture, "codex", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());
    let account = codex_keychain_account(&dir);
    assert!(account.starts_with("cli|") && account.len() == 4 + 16);
    fixture.service.host.keychain = Arc::new(FakeKeychain {
        existing: vec![format!("{CODEX_KEYCHAIN_SERVICE}/{account}")],
        ..FakeKeychain::default()
    });

    let status = fixture
        .service
        .login_status("p-codex", &view.account_id, None)
        .unwrap();

    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.credential_source.as_deref(), Some("keychain"));
    // 是哪个号要读条目内容才知道——不读，所以没有身份。
    assert_eq!(status.identity, None);
}

#[test]
fn gemini_status_reads_the_account_file_under_dot_gemini() {
    let fixture = fixture();
    let view = create(&fixture, "gemini", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());
    assert_eq!(view.status.state, LoginState::NotLoggedIn);

    // 数据在目录变量指向的那一层下面的 `.gemini` 里。
    write(
        &dir.join(".gemini/oauth_creds.json"),
        r#"{"access_token":"GOOGLE-SECRET"}"#,
    );
    write(
        &dir.join(".gemini/google_accounts.json"),
        r#"{"active":"me@gmail.com","old":[]}"#,
    );
    let status = fixture
        .service
        .login_status("p-gemini", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity.as_deref(), Some("me@gmail.com"));
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("GOOGLE-SECRET"));

    // 有账号记录但没有凭据文件：可能用了别的存储方式，未知。
    fs::remove_file(dir.join(".gemini/oauth_creds.json")).unwrap();
    let status = fixture
        .service
        .login_status("p-gemini", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::Unknown);
    assert_eq!(status.identity.as_deref(), Some("me@gmail.com"));
}

#[test]
fn grok_status_reads_email_and_expiry_but_not_the_key() {
    let fixture = fixture();
    let view = create(&fixture, "grok", "work");
    let dir = PathBuf::from(view.config_dir.clone().unwrap());
    assert_eq!(view.status.state, LoginState::NotLoggedIn);

    write(
        &dir.join("auth.json"),
        r#"{"https://auth.x.ai":{"key":"GROK-SECRET","email":"me@x.ai","expires_at":"2026-12-01T00:00:00Z","oidc_issuer":"https://auth.x.ai"}}"#,
    );
    let status = fixture
        .service
        .login_status("p-grok", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::LoggedIn);
    assert_eq!(status.identity.as_deref(), Some("me@x.ai"));
    assert_eq!(status.expires_at.as_deref(), Some("2026-12-01T00:00:00Z"));
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("GROK-SECRET"));

    // 文件在但读不懂：未知。
    write(&dir.join("auth.json"), "[1,2,3]");
    let status = fixture
        .service
        .login_status("p-grok", &view.account_id, None)
        .unwrap();
    assert_eq!(status.state, LoginState::Unknown);
    assert_eq!(status.reason.as_deref(), Some("account_file_unreadable"));
}

/// Antigravity 把凭据放在哪没有核实过：一律未知，不猜。
#[test]
fn antigravity_status_is_always_unknown() {
    let fixture = fixture();
    let view = create(&fixture, "antigravity", "work");
    assert_eq!(view.status.state, LoginState::Unknown);
    assert_eq!(
        view.status.reason.as_deref(),
        Some("antigravity_reports_in_cli")
    );
}

/// 删除账号：目录默认保留；要求删目录时只删 CC-Panes 自己建的，且链接指向的默认目录原件不受影响。
#[cfg(unix)]
#[test]
fn deleting_an_account_keeps_the_dir_by_default_and_only_removes_managed_dirs() {
    let fixture = fixture();
    seed_default_dirs(&fixture.home);
    let kept = create(&fixture, "claude", "keep-dir");
    let removed = create(&fixture, "claude", "remove-dir");
    let kept_dir = PathBuf::from(kept.config_dir.clone().unwrap());
    let removed_dir = PathBuf::from(removed.config_dir.clone().unwrap());
    write(&removed_dir.join("projects/p/s.jsonl"), "{}");

    // 默认不删目录。
    let outcome = fixture
        .service
        .delete_account("p-claude", &kept.account_id, false)
        .unwrap();
    assert!(!outcome.dir_deleted);
    assert_eq!(outcome.dir_kept_reason, None);
    assert_eq!(outcome.config_dir, kept.config_dir);
    assert!(kept_dir.is_dir());

    // 同时删目录：目录没了，默认目录里被链接的原件还在。
    let outcome = fixture
        .service
        .delete_account("p-claude", &removed.account_id, true)
        .unwrap();
    assert!(outcome.dir_deleted);
    assert!(!removed_dir.exists());
    assert!(fixture.home.join(".claude/settings.json").is_file());
    assert!(fixture.home.join(".claude/skills/a/SKILL.md").is_file());
    assert!(fixture.home.join(".claude/.credentials.json").is_file());

    let provider = fixture.providers.get_provider("p-claude").unwrap();
    assert_eq!(
        provider.accounts.len(),
        1,
        "only the original account is left"
    );

    // 删掉的账号再启动：明确报错，不会悄悄换成默认账号。
    let error = fixture
        .providers
        .resolve_launch_env(&provider, Some(&removed.account_id), "claude")
        .unwrap_err();
    assert!(error.to_string().contains("was not found"));
}

/// 用户手填的外部目录永不删除——哪怕它里面有一个伪造的标记文件，哪怕账号目录根下有个
/// 链接指向它。
#[cfg(unix)]
#[test]
fn external_dirs_are_never_deleted() {
    let fixture = fixture();
    let external = fixture.home.join("my-own-claude-dir");
    write(&external.join("projects/p/s.jsonl"), "{}");
    let add = |id: &str, dir: &Path| {
        fixture
            .providers
            .add_account(
                "p-claude",
                ProviderAccount {
                    id: id.to_string(),
                    name: id.to_string(),
                    kind: AccountKind::Login,
                    cli_tool: Some("claude".to_string()),
                    config_dir: Some(dir.to_string_lossy().into_owned()),
                    ..ProviderAccount::default()
                },
            )
            .unwrap();
    };

    // 1. 完全在根之外的目录。
    add("external", &external);
    let outcome = fixture
        .service
        .delete_account("p-claude", "external", true)
        .unwrap();
    assert!(!outcome.dir_deleted);
    assert_eq!(outcome.dir_kept_reason.as_deref(), Some("external_dir"));
    assert!(external.join("projects/p/s.jsonl").is_file());

    // 2. 根之外的目录里放了伪造的标记文件。
    write(
        &external.join(ACCOUNT_MARKER_FILE),
        r#"{"schema":1,"accountId":"forged","providerId":"p-claude","cliTool":"claude","createdAt":"x"}"#,
    );
    add("forged", &external);
    let outcome = fixture
        .service
        .delete_account("p-claude", "forged", true)
        .unwrap();
    assert_eq!(outcome.dir_kept_reason.as_deref(), Some("external_dir"));
    assert!(external.is_dir());

    // 3. 账号目录根下的一个软链接指向外部目录。
    fs::create_dir_all(&fixture.root).unwrap();
    let link = fixture.root.join("claude-linkedout");
    std::os::unix::fs::symlink(&external, &link).unwrap();
    add("linked", &link);
    let outcome = fixture
        .service
        .delete_account("p-claude", "linked", true)
        .unwrap();
    assert_eq!(outcome.dir_kept_reason.as_deref(), Some("external_dir"));
    assert!(external.join("projects/p/s.jsonl").is_file());

    // 4. 根下别的账号的目录（标记里的账号 id 对不上）。
    let other = create(&fixture, "claude", "other");
    add("impostor", Path::new(other.config_dir.as_deref().unwrap()));
    let outcome = fixture
        .service
        .delete_account("p-claude", "impostor", true)
        .unwrap();
    assert_eq!(outcome.dir_kept_reason.as_deref(), Some("external_dir"));
    assert!(Path::new(other.config_dir.as_deref().unwrap()).is_dir());

    // 5. 路径逃逸：`<根>/x/../../home`。
    let escaping = fixture
        .root
        .join("x")
        .join("..")
        .join("..")
        .join("..")
        .join("home");
    add("escaping", &escaping);
    let outcome = fixture
        .service
        .delete_account("p-claude", "escaping", true)
        .unwrap();
    assert!(!outcome.dir_deleted);
    assert!(fixture.home.is_dir());
}

#[test]
fn the_last_account_of_a_provider_cannot_be_deleted() {
    let fixture = fixture();
    let error = fixture
        .service
        .delete_account("p-claude", DEFAULT_ACCOUNT_ID, false)
        .unwrap_err();
    assert_eq!(error.code(), Some("PROVIDER_ACCOUNT_LAST"));
}

/// 删默认账号后，默认账号改成剩下的第一个；别的账号的密钥标记不受影响。
#[test]
fn deleting_the_default_account_falls_back_to_the_first_remaining_one() {
    let fixture = fixture();
    let view = create(&fixture, "claude", "work");

    fixture
        .service
        .delete_account("p-claude", DEFAULT_ACCOUNT_ID, false)
        .unwrap();

    let provider = fixture.providers.get_provider("p-claude").unwrap();
    assert_eq!(
        provider.default_account_id.as_deref(),
        Some(view.account_id.as_str())
    );
}

/// 会话索引 / 用量统计用的账号目录清单：只含有转录解析器的 CLI，带账号归属。
#[test]
fn account_roots_cover_claude_and_codex_login_accounts() {
    let fixture = fixture();
    let claude = create(&fixture, "claude", "个人号");
    let codex = create(&fixture, "codex", "work");
    create(&fixture, "gemini", "g");
    create(&fixture, "grok", "x");

    let mut roots = fixture.service.account_roots();
    roots.sort_by(|a, b| a.cli_tool.cmp(&b.cli_tool));

    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0].cli_tool, "claude");
    assert_eq!(roots[0].provider_id, "p-claude");
    assert_eq!(roots[0].account_id, claude.account_id);
    assert_eq!(roots[0].account_name, "个人号");
    assert_eq!(
        roots[0].transcript_dir,
        Path::new(claude.config_dir.as_deref().unwrap()).join("projects")
    );
    assert_eq!(
        roots[1].transcript_dir,
        Path::new(codex.config_dir.as_deref().unwrap()).join("sessions")
    );
}

/// 账号目录根只有一个出处：数据目录下的 `login-accounts`。
#[test]
fn accounts_root_lives_under_the_cc_panes_data_dir() {
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::utils::AppPaths::new(Some(temp.path().to_string_lossy().into_owned()));
    let providers = Arc::new(ProviderService::new(paths.providers_path()));

    let service = LoginAccountService::for_provider_service(providers);

    assert_eq!(service.accounts_root(), paths.login_accounts_dir());
    assert_eq!(
        paths.login_accounts_dir(),
        paths.data_dir().join("login-accounts")
    );
}

/// 删除登录账号时不碰 CLI 自己的钥匙串条目，只在结果里提示「凭据可能还在」并给 logout 命令。
#[test]
fn deleting_a_login_account_reports_keychain_credentials_that_may_remain() {
    let fixture = fixture();
    let claude = create(&fixture, "claude", "claude-work");
    let codex = create(&fixture, "codex", "codex-work");
    let grok = create(&fixture, "grok", "grok-work");
    let claude_dir = claude.config_dir.clone().unwrap();
    let codex_dir = codex.config_dir.clone().unwrap();
    let claude_item = claude_keychain_service(Some(&claude_dir));
    let codex_item = format!(
        "{CODEX_KEYCHAIN_SERVICE}/{}",
        codex_keychain_account(Path::new(&codex_dir))
    );

    // 钥匙串里查得到条目：提示，并给出带目录变量的 logout 命令。
    let mut service = fixture.service;
    service.host.keychain = Arc::new(FakeKeychain {
        existing: vec![claude_item, codex_item],
        ..FakeKeychain::default()
    });
    let outcome = service
        .delete_account("p-claude", &claude.account_id, true)
        .unwrap();
    assert!(outcome.dir_deleted);
    assert!(outcome.keychain_credentials_may_remain);
    assert_eq!(
        outcome.logout_command.as_deref(),
        Some(format!("CLAUDE_CONFIG_DIR='{claude_dir}' claude auth logout").as_str())
    );
    let outcome = service
        .delete_account("p-codex", &codex.account_id, false)
        .unwrap();
    assert!(outcome.keychain_credentials_may_remain);
    assert_eq!(
        outcome.logout_command.as_deref(),
        Some(format!("CODEX_HOME='{codex_dir}' codex logout").as_str())
    );

    // 凭据只放目录里的 CLI（Grok）不提示。
    let outcome = service
        .delete_account("p-grok", &grok.account_id, false)
        .unwrap();
    assert!(!outcome.keychain_credentials_may_remain);
    assert_eq!(outcome.logout_command, None);
}

#[test]
fn keychain_hint_follows_what_the_probe_can_tell() {
    let fixture = fixture();
    let absent = create(&fixture, "claude", "absent");
    let unknown = create(&fixture, "claude", "unknown");
    let mut service = fixture.service;

    // 查得到「条目不在」：不提示。
    let outcome = service
        .delete_account("p-claude", &absent.account_id, false)
        .unwrap();
    assert!(!outcome.keychain_credentials_may_remain);

    // 查不了：macOS 上按「可能还在」提示，其他平台这两个 CLI 不用钥匙串。
    service.host.keychain = Arc::new(FakeKeychain {
        unavailable: true,
        ..FakeKeychain::default()
    });
    let outcome = service
        .delete_account("p-claude", &unknown.account_id, false)
        .unwrap();
    assert_eq!(
        outcome.keychain_credentials_may_remain,
        cfg!(target_os = "macos")
    );
    assert_eq!(outcome.logout_command.is_some(), cfg!(target_os = "macos"));
}

#[test]
fn shell_quote_escapes_single_quotes() {
    assert_eq!(super::shell_quote("/a b/it's"), r"'/a b/it'\''s'");
}
