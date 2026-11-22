//! 账号 / 多接口 / 环境变量 / 钥匙串 / 旧数据迁移的测试。
//!
//! 全部用临时目录和内存密钥存储，不碰真实数据目录，也不碰系统钥匙串。

use super::*;
use crate::models::provider::{
    AccountKind, EndpointKind, ProviderAccount, ProviderEndpoints, ProviderEnvVar, SecretStorage,
    DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_NAME, PROVIDER_SCHEMA_VERSION,
};
use crate::services::provider_secret_service::{
    account_env_secret_key, account_secret_key, provider_env_secret_key, ProviderSecretBackend,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

const OLD_ANTHROPIC_KEY: &str = "sk-ant-OLD-SECRET-0001";
const OLD_CODEX_KEY: &str = "sk-codex-OLD-SECRET-0002";

fn memory_store() -> Arc<ProviderSecretStore> {
    Arc::new(ProviderSecretStore::memory())
}

fn providers_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("providers.json")
}

fn owner(dir: &tempfile::TempDir, store: &Arc<ProviderSecretStore>) -> ProviderService {
    ProviderService::with_secret_store(providers_path(dir), store.clone())
}

fn read_file(dir: &tempfile::TempDir) -> String {
    std::fs::read_to_string(providers_path(dir)).unwrap()
}

fn read_json(dir: &tempfile::TempDir) -> Value {
    serde_json::from_str(&read_file(dir)).unwrap()
}

fn backups(dir: &tempfile::TempDir) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("providers.json.bak-"))
        })
        .collect();
    found.sort();
    found
}

/// 升级前的 providers.json：三条供应商，含一条「配置目录」类型。
fn write_legacy_file(dir: &tempfile::TempDir) -> String {
    let profile_dir = dir.path().join("claude-personal");
    std::fs::create_dir_all(&profile_dir).unwrap();
    let raw = serde_json::to_string_pretty(&json!({
        "providers": [
            {
                "id": "p-anthropic",
                "name": "Anthropic 工作号",
                "providerType": "anthropic",
                "apiKey": OLD_ANTHROPIC_KEY,
                "baseUrl": "https://api.example.com",
                "models": [{ "id": "claude-x" }],
                "defaultModelId": "claude-x",
                "isDefault": true
            },
            {
                "id": "p-codex",
                "name": "Relay",
                "providerType": "open_ai",
                "apiKey": OLD_CODEX_KEY,
                "baseUrl": "https://relay.example/v1",
                "codexWireApi": "chat",
                "isDefault": false
            },
            {
                "id": "p-profile",
                "name": "个人号",
                "providerType": "config_profile",
                "configDir": profile_dir.to_string_lossy(),
                "isDefault": false
            }
        ],
        "default_provider_ids": { "claude": "p-anthropic", "codex": "p-codex" },
        "default_provider_ids_version": 2,
        "default_is_system": false
    }))
    .unwrap();
    std::fs::write(providers_path(dir), &raw).unwrap();
    raw
}

fn provider_json<'a>(file: &'a Value, id: &str) -> &'a Value {
    file["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["id"] == id)
        .unwrap_or_else(|| panic!("provider {id} missing from file"))
}

fn key_account(id: &str, name: &str, secret: Option<&str>) -> ProviderAccount {
    ProviderAccount {
        id: id.to_string(),
        name: name.to_string(),
        kind: AccountKind::ApiKey,
        secret: secret.map(str::to_string),
        ..ProviderAccount::default()
    }
}

fn login_account(id: &str, cli_tool: &str, dir: &str) -> ProviderAccount {
    ProviderAccount {
        id: id.to_string(),
        name: format!("{cli_tool} 登录"),
        kind: AccountKind::Login,
        cli_tool: Some(cli_tool.to_string()),
        config_dir: Some(dir.to_string()),
        ..ProviderAccount::default()
    }
}

fn env_var(name: &str, value: &str, sensitive: bool) -> ProviderEnvVar {
    ProviderEnvVar {
        name: name.to_string(),
        value: Some(value.to_string()),
        sensitive,
        storage: SecretStorage::None,
    }
}

fn new_provider(id: &str, provider_type: ProviderType) -> Provider {
    Provider {
        id: id.to_string(),
        name: format!("Provider {id}"),
        provider_type,
        ..Provider::default()
    }
}

/// 第 N 次写入起一律失败的钥匙串（N 从 0 计）。
struct FailingWrites {
    inner: ProviderSecretStore,
    fail_from: usize,
    writes: AtomicUsize,
}

impl FailingWrites {
    fn store(fail_from: usize) -> (Arc<ProviderSecretStore>, Arc<FailingWrites>) {
        let backend = Arc::new(FailingWrites {
            inner: ProviderSecretStore::memory(),
            fail_from,
            writes: AtomicUsize::new(0),
        });
        (
            Arc::new(ProviderSecretStore::with_backend(backend.clone())),
            backend,
        )
    }
}

impl ProviderSecretBackend for FailingWrites {
    fn is_available(&self) -> bool {
        true
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        if self.writes.fetch_add(1, Ordering::SeqCst) >= self.fail_from {
            anyhow::bail!("credential store rejected the write");
        }
        self.inner.store(key, value)
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        self.inner.load(key)
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(key)
    }
}

/// 钥匙串「在」，但任何读取都失败（用户拒绝授权 / 条目读不出）。
struct UnreadableSecrets;

impl ProviderSecretBackend for UnreadableSecrets {
    fn is_available(&self) -> bool {
        true
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        anyhow::bail!("secret access requires authorization")
    }
    fn delete(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------- 旧数据迁移

#[test]
fn legacy_file_migrates_to_accounts_endpoints_and_keychain() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write_legacy_file(&dir);
    let store = memory_store();

    let service = owner(&dir, &store);

    let file = read_json(&dir);
    assert_eq!(file["schema_version"], PROVIDER_SCHEMA_VERSION);
    // 默认供应商映射等原有数据不变。
    assert_eq!(file["default_provider_ids"]["claude"], "p-anthropic");
    assert_eq!(file["default_provider_ids"]["codex"], "p-codex");

    // 旧供应商 → 一个供应商 + 一个叫「默认」的密钥账号；地址进它类型对应的接口。
    let anthropic = provider_json(&file, "p-anthropic");
    for legacy in ["apiKey", "baseUrl", "configDir"] {
        assert!(
            anthropic.get(legacy).is_none(),
            "{legacy} must not be persisted"
        );
    }
    assert_eq!(
        anthropic["endpoints"],
        json!({ "anthropic": "https://api.example.com" })
    );
    assert_eq!(anthropic["defaultAccountId"], DEFAULT_ACCOUNT_ID);
    assert_eq!(
        anthropic["accounts"],
        json!([{
            "id": DEFAULT_ACCOUNT_ID,
            "name": DEFAULT_ACCOUNT_NAME,
            "kind": "api_key",
            "secretStorage": "keychain"
        }])
    );
    assert_eq!(anthropic["models"][0]["id"], "claude-x");
    assert_eq!(anthropic["defaultModelId"], "claude-x");

    // Codex 的 wire API 是 chat：地址进 Chat 接口。
    let codex = provider_json(&file, "p-codex");
    assert_eq!(
        codex["endpoints"],
        json!({ "chat": "https://relay.example/v1" })
    );
    assert_eq!(codex["codexWireApi"], "chat");

    // 「配置目录」类型 → 一个 Claude 登录账号，目录在账号上。
    let profile = provider_json(&file, "p-profile");
    let profile_dir = dir.path().join("claude-personal");
    assert_eq!(
        profile["accounts"],
        json!([{
            "id": DEFAULT_ACCOUNT_ID,
            "name": DEFAULT_ACCOUNT_NAME,
            "kind": "login",
            "cliTool": "claude",
            "configDir": profile_dir.to_string_lossy()
        }])
    );
    assert!(profile.get("endpoints").is_none());

    // 密钥在钥匙串里，文件里搜不到。
    let content = read_file(&dir);
    assert!(!content.contains(OLD_ANTHROPIC_KEY));
    assert!(!content.contains(OLD_CODEX_KEY));
    assert_eq!(
        store
            .load(&account_secret_key("p-anthropic", DEFAULT_ACCOUNT_ID))
            .unwrap()
            .as_deref(),
        Some(OLD_ANTHROPIC_KEY)
    );
    assert_eq!(
        store
            .load(&account_secret_key("p-codex", DEFAULT_ACCOUNT_ID))
            .unwrap()
            .as_deref(),
        Some(OLD_CODEX_KEY)
    );

    // 迁移前的原文件备份在同目录，内容一字不差。
    let backups = backups(&dir);
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), raw);

    // 行为不变：原来的供应商照常解析出同样的环境变量。
    let vars = service.get_env_vars(Some("p-anthropic"));
    assert_eq!(
        vars.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
    assert_eq!(
        vars.get("ANTHROPIC_BASE_URL").map(String::as_str),
        Some("https://api.example.com")
    );
    let vars = service.get_env_vars(Some("p-profile"));
    assert_eq!(
        vars,
        HashMap::from([(
            "CLAUDE_CONFIG_DIR".to_string(),
            profile_dir.to_string_lossy().to_string()
        )])
    );
}

#[test]
fn migration_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    let store = memory_store();

    let first_service = owner(&dir, &store);
    let _ = first_service.list_providers();
    assert_eq!(backups(&dir).len(), 1, "no extra backups within the run");
    drop(first_service);
    let first = read_file(&dir);
    let second_service = owner(&dir, &store);
    let _ = second_service.list_providers();
    let second = read_file(&dir);
    drop(second_service);
    drop(owner(&dir, &store));

    assert_eq!(first, second, "a second run must not change the file");
    assert_eq!(read_file(&dir), first);
    // 第二次启动是一次验证过的正常加载：带明文的备份删掉了，之后也不再生成。
    assert!(
        backups(&dir).is_empty(),
        "no backups left after a verified load"
    );
}

#[test]
fn migration_backups_are_deleted_after_the_next_verified_start() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    let store = memory_store();

    // 迁移这次启动：备份留着（这时还没被一次正常加载验证过）。
    drop(owner(&dir, &store));
    assert_eq!(backups(&dir).len(), 1);
    assert_eq!(read_json(&dir)["schema_version"], PROVIDER_SCHEMA_VERSION);

    // 跟随者（daemon）只读，不删。
    drop(ProviderService::follower(
        providers_path(&dir),
        store.clone(),
    ));
    assert_eq!(backups(&dir).len(), 1);

    // 下次启动：新格式、密钥都在钥匙串里读得到 → 删备份；配置照常可用。
    let service = owner(&dir, &store);
    assert!(backups(&dir).is_empty());
    assert_eq!(
        service
            .get_env_vars(Some("p-anthropic"))
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
}

#[test]
fn migration_backups_are_kept_while_a_secret_cannot_be_located() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    drop(owner(&dir, &memory_store()));
    assert_eq!(backups(&dir).len(), 1);

    // 换了一个空的钥匙串（比如钥匙串被重置）：文件说密钥在钥匙串，实际读不到。
    // 备份可能是唯一的副本，不能删。
    drop(owner(&dir, &memory_store()));
    assert_eq!(backups(&dir).len(), 1);

    // 没有钥匙串的环境同理：标记是 keychain 的找不到。
    drop(ProviderService::new(providers_path(&dir)));
    assert_eq!(backups(&dir).len(), 1);
}

#[test]
fn migration_backups_are_deleted_when_secrets_stay_in_the_file() {
    // 没有钥匙串：迁移后密钥以 `file` 留在 providers.json，同样算「能定位」。
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    drop(ProviderService::new(providers_path(&dir)));
    assert_eq!(backups(&dir).len(), 1);

    drop(ProviderService::new(providers_path(&dir)));
    assert!(backups(&dir).is_empty());
}

#[test]
fn failing_to_delete_a_migration_backup_only_logs() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    let store = memory_store();
    drop(owner(&dir, &store));
    // 一个删不掉的「备份」（同名前缀的目录，remove_file 会失败）。
    let stuck = dir.path().join("providers.json.bak-stuck");
    std::fs::create_dir(&stuck).unwrap();

    let service = owner(&dir, &store);

    assert!(stuck.exists());
    assert_eq!(backups(&dir), vec![stuck]);
    assert_eq!(
        service
            .get_env_vars(Some("p-codex"))
            .get("CODEX_API_KEY")
            .map(String::as_str),
        Some(OLD_CODEX_KEY)
    );
}

#[test]
fn failed_migration_keeps_the_original_file_and_retries_on_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write_legacy_file(&dir);
    // 第一把密钥写进去了，第二把失败：必须整体撤回，不能半迁移。
    let (store, backend) = FailingWrites::store(1);

    let service = owner(&dir, &store);

    assert_eq!(read_file(&dir), raw, "original file must be untouched");
    assert!(backend.writes.load(Ordering::SeqCst) >= 2);
    for id in ["p-anthropic", "p-codex"] {
        assert_eq!(
            store
                .load(&account_secret_key(id, DEFAULT_ACCOUNT_ID))
                .unwrap(),
            None,
            "partially stored secrets must be rolled back"
        );
    }
    // 这次启动仍然能用（内存里按新结构工作），密钥没有丢。
    assert_eq!(
        service
            .get_env_vars(Some("p-anthropic"))
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
    // 本进程内不反复重试。
    let writes_after_first_attempt = backend.writes.load(Ordering::SeqCst);
    let _ = service.list_providers();
    assert_eq!(
        backend.writes.load(Ordering::SeqCst),
        writes_after_first_attempt
    );
    assert_eq!(read_file(&dir), raw);
    // 对界面如实标成「未进钥匙串」，且不带明文。
    let shown = service.get_provider_for_display("p-anthropic").unwrap();
    assert_eq!(shown.accounts[0].secret, None);
    assert_eq!(shown.accounts[0].secret_storage, SecretStorage::File);
    drop(service);

    // 下次启动（钥匙串恢复正常）再试，成功。
    let healthy = memory_store();
    let service = owner(&dir, &healthy);
    assert_eq!(read_json(&dir)["schema_version"], PROVIDER_SCHEMA_VERSION);
    assert!(!read_file(&dir).contains(OLD_ANTHROPIC_KEY));
    assert_eq!(
        service
            .get_env_vars(Some("p-codex"))
            .get("CODEX_API_KEY")
            .map(String::as_str),
        Some(OLD_CODEX_KEY)
    );
    assert_eq!(std::fs::read_to_string(&backups(&dir)[0]).unwrap(), raw);
}

#[test]
fn follower_reads_a_legacy_file_without_writing_anything() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write_legacy_file(&dir);
    let store = memory_store();

    // daemon：只读，不迁移、不写钥匙串。
    let follower = ProviderService::follower(providers_path(&dir), store.clone());

    assert_eq!(read_file(&dir), raw);
    assert!(backups(&dir).is_empty());
    assert_eq!(
        store
            .load(&account_secret_key("p-anthropic", DEFAULT_ACCOUNT_ID))
            .unwrap(),
        None
    );
    assert_eq!(
        follower
            .get_env_vars(Some("p-anthropic"))
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
}

#[test]
fn follower_uses_secrets_pushed_by_the_owner_process() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);
    let owner_store = memory_store();
    let owner_service = owner(&dir, &owner_store);

    // daemon 自己的钥匙串读不到这些条目（另一个可执行文件）。
    let daemon_store = Arc::new(ProviderSecretStore::with_backend(Arc::new(
        UnreadableSecrets,
    )));
    let daemon = ProviderService::follower(providers_path(&dir), daemon_store.clone());
    let provider = daemon.get_provider("p-anthropic").unwrap();
    let error = daemon
        .resolve_launch_env(&provider, None, "claude")
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<AppError>().and_then(|e| e.code()),
        Some("PROVIDER_SECRET_UNAVAILABLE")
    );

    // 主程序读出这次启动要用的条目，推给 daemon 的内存。
    let entries = owner_service
        .launch_secret_entries(&owner_service.get_provider("p-anthropic").unwrap(), None)
        .unwrap();
    assert_eq!(
        entries,
        HashMap::from([(
            account_secret_key("p-anthropic", DEFAULT_ACCOUNT_ID),
            OLD_ANTHROPIC_KEY.to_string()
        )])
    );
    daemon_store.set_temporary(entries);

    let resolved = daemon
        .resolve_launch_env(&provider, None, "claude")
        .unwrap();
    assert_eq!(resolved.api_key.as_deref(), Some(OLD_ANTHROPIC_KEY));
    assert_eq!(
        resolved
            .env_map()
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
}

// ---------------------------------------------------------------- 密钥不落盘

#[test]
fn secrets_and_sensitive_env_values_never_reach_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);

    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.endpoints.anthropic = Some("https://api.example.com".to_string());
    provider.env = vec![
        env_var("API_TIMEOUT_MS", "600000", false),
        env_var("PROVIDER_TOKEN", "provider-env-SECRET", true),
    ];
    let mut work = key_account("work", "工作号", Some("sk-work-SECRET"));
    work.env = vec![env_var("ACCOUNT_TOKEN", "account-env-SECRET", true)];
    provider.accounts = vec![work, key_account("home", "个人号", Some("sk-home-SECRET"))];
    provider.default_account_id = Some("work".to_string());
    service.add_provider(provider).unwrap();

    let content = read_file(&dir);
    for secret in [
        "sk-work-SECRET",
        "sk-home-SECRET",
        "provider-env-SECRET",
        "account-env-SECRET",
    ] {
        assert!(!content.contains(secret), "{secret} leaked into the file");
    }
    assert!(
        content.contains("600000"),
        "plain env values stay in the file"
    );

    let file = read_json(&dir);
    let saved = provider_json(&file, "p1");
    assert_eq!(saved["accounts"][0]["secretStorage"], "keychain");
    assert_eq!(saved["accounts"][1]["secretStorage"], "keychain");
    assert_eq!(
        saved["env"][1],
        json!({ "name": "PROVIDER_TOKEN", "sensitive": true, "storage": "keychain" })
    );
    assert_eq!(
        saved["accounts"][0]["env"][0],
        json!({ "name": "ACCOUNT_TOKEN", "sensitive": true, "storage": "keychain" })
    );

    assert_eq!(
        store
            .load(&account_secret_key("p1", "work"))
            .unwrap()
            .as_deref(),
        Some("sk-work-SECRET")
    );
    assert_eq!(
        store
            .load(&provider_env_secret_key("p1", "PROVIDER_TOKEN"))
            .unwrap()
            .as_deref(),
        Some("provider-env-SECRET")
    );
    assert_eq!(
        store
            .load(&account_env_secret_key("p1", "work", "ACCOUNT_TOKEN"))
            .unwrap()
            .as_deref(),
        Some("account-env-SECRET")
    );

    // 给界面的副本同样不带明文。
    let shown = serde_json::to_string(&service.list_providers_for_display()).unwrap();
    assert!(!shown.contains("SECRET"));
}

#[test]
fn editing_through_a_redacted_copy_keeps_replaces_and_clears_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.accounts = vec![
        key_account("work", "工作号", Some("sk-work-1")),
        key_account("home", "个人号", Some("sk-home-1")),
    ];
    service.add_provider(provider).unwrap();

    // 界面改名后原样存回：密钥保持不变。
    let mut edited = service.get_provider_for_display("p1").unwrap();
    edited.name = "Renamed".to_string();
    service.update_provider(edited).unwrap();
    assert_eq!(
        store
            .load(&account_secret_key("p1", "work"))
            .unwrap()
            .as_deref(),
        Some("sk-work-1")
    );

    // 填新密钥 = 替换；把标记清成 none = 清除；删掉账号 = 钥匙串条目一并删除。
    let mut edited = service.get_provider_for_display("p1").unwrap();
    edited.accounts[0].secret = Some("sk-work-2".to_string());
    edited.accounts[1].secret_storage = SecretStorage::None;
    service.update_provider(edited).unwrap();
    assert_eq!(
        store
            .load(&account_secret_key("p1", "work"))
            .unwrap()
            .as_deref(),
        Some("sk-work-2")
    );
    assert_eq!(store.load(&account_secret_key("p1", "home")).unwrap(), None);
    assert!(!service.get_provider("p1").unwrap().accounts[1].has_secret());

    service.remove_provider("p1").unwrap();
    assert_eq!(store.load(&account_secret_key("p1", "work")).unwrap(), None);
}

#[test]
fn legacy_client_writes_edit_the_default_account() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);

    // 旧界面只认识 apiKey / baseUrl：新建等于建了默认账号。
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.api_key = Some("sk-first".to_string());
    provider.base_url = Some("https://one.example".to_string());
    service.add_provider(provider).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(saved.default_account().unwrap().name, DEFAULT_ACCOUNT_NAME);
    assert_eq!(
        saved.endpoints.get(EndpointKind::Anthropic),
        Some("https://one.example")
    );
    assert_eq!(saved.base_url.as_deref(), Some("https://one.example"));
    assert_eq!(saved.api_key, None, "the key is never mirrored back");

    // 旧界面保存时不带账号、不带密钥（读不到）：密钥保持，地址照改。
    let mut edited = new_provider("p1", ProviderType::Anthropic);
    edited.base_url = Some("https://two.example".to_string());
    service.update_provider(edited).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(
        saved.endpoints.get(EndpointKind::Anthropic),
        Some("https://two.example")
    );
    assert_eq!(
        store
            .load(&account_secret_key("p1", DEFAULT_ACCOUNT_ID))
            .unwrap()
            .as_deref(),
        Some("sk-first")
    );

    // 旧界面读得到地址，所以清空地址就是清空（密钥读不到，缺省才表示不动）。
    service
        .update_provider(new_provider("p1", ProviderType::Anthropic))
        .unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert!(saved.endpoints.is_empty());
    assert_eq!(saved.base_url, None);
    assert!(saved.accounts[0].has_secret());

    // 旧界面填了新密钥：换掉默认账号的密钥。
    let mut edited = new_provider("p1", ProviderType::Anthropic);
    edited.api_key = Some("sk-second".to_string());
    edited.base_url = Some("https://two.example".to_string());
    service.update_provider(edited).unwrap();
    assert_eq!(
        store
            .load(&account_secret_key("p1", DEFAULT_ACCOUNT_ID))
            .unwrap()
            .as_deref(),
        Some("sk-second")
    );
    assert!(!read_file(&dir).contains("sk-second"));

    // 新界面加的其它接口、账号、环境变量，旧界面保存时不会被抹掉。
    let mut edited = service.get_provider_for_display("p1").unwrap();
    edited.endpoints.chat = Some("https://two.example/v1".to_string());
    edited.env = vec![env_var("API_TIMEOUT_MS", "600000", false)];
    edited
        .accounts
        .push(key_account("home", "个人号", Some("sk-home")));
    service.update_provider(edited).unwrap();
    let mut legacy_edit = new_provider("p1", ProviderType::Anthropic);
    legacy_edit.name = "Renamed by the old form".to_string();
    legacy_edit.base_url = Some("https://three.example".to_string());
    service.update_provider(legacy_edit).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(saved.name, "Renamed by the old form");
    assert_eq!(
        saved.endpoints.get(EndpointKind::Anthropic),
        Some("https://three.example")
    );
    assert_eq!(
        saved.endpoints.get(EndpointKind::Chat),
        Some("https://two.example/v1")
    );
    assert_eq!(saved.env.len(), 1);
    assert_eq!(saved.accounts.len(), 2);
    assert!(saved.accounts.iter().all(ProviderAccount::has_secret));
}

#[test]
fn stale_legacy_mirror_does_not_overwrite_new_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let service = owner(&dir, &memory_store());
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.endpoints.anthropic = Some("https://old.example".to_string());
    service.add_provider(provider).unwrap();

    // 新界面改了 endpoints，但把读到的 baseUrl 镜像原样带了回来。
    let mut edited = service.get_provider_for_display("p1").unwrap();
    assert_eq!(edited.base_url.as_deref(), Some("https://old.example"));
    edited.endpoints.anthropic = Some("https://new.example".to_string());
    edited.endpoints.chat = Some("https://new.example/v1".to_string());
    service.update_provider(edited).unwrap();

    let saved = service.get_provider("p1").unwrap();
    assert_eq!(
        saved.endpoints,
        ProviderEndpoints {
            anthropic: Some("https://new.example".to_string()),
            chat: Some("https://new.example/v1".to_string()),
            ..ProviderEndpoints::default()
        }
    );
}

// ---------------------------------------------------------------- 没有钥匙串

#[test]
fn without_a_credential_store_secrets_stay_in_the_file_and_are_marked() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_file(&dir);

    // `ProviderService::new` = 没有钥匙串（无界面 Linux / 关掉 secret-service 的 cc-panes-web）。
    let service = ProviderService::new(providers_path(&dir));
    assert!(!service.keychain_available());

    // 结构照常迁移，密钥保持文件存储，并标明「未进钥匙串」。
    let file = read_json(&dir);
    assert_eq!(file["schema_version"], PROVIDER_SCHEMA_VERSION);
    let account = &provider_json(&file, "p-anthropic")["accounts"][0];
    assert_eq!(account["secretStorage"], "file");
    assert_eq!(account["secret"], OLD_ANTHROPIC_KEY);
    assert!(provider_json(&file, "p-anthropic").get("apiKey").is_none());

    // 启动照常能用。
    assert_eq!(
        service
            .get_env_vars(Some("p-anthropic"))
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(OLD_ANTHROPIC_KEY)
    );
    // 给界面的副本只带标记，不带明文。
    let shown = service.get_provider_for_display("p-anthropic").unwrap();
    assert_eq!(shown.accounts[0].secret_storage, SecretStorage::File);
    assert_eq!(shown.accounts[0].secret, None);
    assert!(!serde_json::to_string(&shown)
        .unwrap()
        .contains(OLD_ANTHROPIC_KEY));

    // 界面原样存回不会把文件里的密钥弄丢；新加的敏感变量同样留在文件并打标。
    let mut edited = shown;
    edited.env = vec![env_var("EXTRA_TOKEN", "extra-SECRET", true)];
    service.update_provider(edited).unwrap();
    let file = read_json(&dir);
    let saved = provider_json(&file, "p-anthropic");
    assert_eq!(saved["accounts"][0]["secret"], OLD_ANTHROPIC_KEY);
    assert_eq!(
        saved["env"][0],
        json!({ "name": "EXTRA_TOKEN", "value": "extra-SECRET", "sensitive": true, "storage": "file" })
    );
    drop(service);

    // 之后环境里有了钥匙串：下次启动搬进去，文件里不再有明文。
    let store = memory_store();
    let service = owner(&dir, &store);
    let content = read_file(&dir);
    assert!(!content.contains(OLD_ANTHROPIC_KEY));
    assert!(!content.contains("extra-SECRET"));
    assert_eq!(
        service.get_provider("p-anthropic").unwrap().accounts[0].secret_storage,
        SecretStorage::Keychain
    );
    assert_eq!(
        store
            .load(&provider_env_secret_key("p-anthropic", "EXTRA_TOKEN"))
            .unwrap()
            .as_deref(),
        Some("extra-SECRET")
    );
}

#[test]
fn a_failing_credential_store_is_an_error_not_a_silent_plaintext_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _backend) = FailingWrites::store(0);
    let service = owner(&dir, &store);
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.accounts = vec![key_account("work", "工作号", Some("sk-SECRET"))];

    assert!(service.add_provider(provider).is_err());

    assert!(service.list_providers().is_empty());
    assert!(!providers_path(&dir).exists() || !read_file(&dir).contains("sk-SECRET"));
}

#[test]
fn a_missing_keychain_entry_fails_the_launch_instead_of_dropping_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.accounts = vec![key_account("work", "工作号", Some("sk-1"))];
    service.add_provider(provider).unwrap();
    store.delete(&account_secret_key("p1", "work")).unwrap();

    let provider = service.get_provider("p1").unwrap();
    let error = service
        .resolve_launch_env(&provider, None, "claude")
        .unwrap_err();

    assert_eq!(
        error.downcast_ref::<AppError>().and_then(|e| e.code()),
        Some("PROVIDER_SECRET_UNAVAILABLE")
    );
    assert!(service.launch_secret_entries(&provider, None).is_err());
}

// ---------------------------------------------------------------- 环境变量解析

#[test]
fn env_layers_apply_generated_then_provider_then_account() {
    let dir = tempfile::tempdir().unwrap();
    let service = owner(&dir, &memory_store());
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.endpoints.anthropic = Some("https://generated.example".to_string());
    provider.env = vec![
        env_var("ANTHROPIC_BASE_URL", "https://provider.example", false),
        env_var("SHARED", "from-provider", false),
        env_var("PROVIDER_ONLY", "p", false),
    ];
    let mut account = key_account("work", "工作号", Some("sk-work"));
    account.env = vec![
        env_var("SHARED", "from-account", false),
        env_var("ANTHROPIC_API_KEY", "sk-account-override", true),
        env_var("ACCOUNT_ONLY", "a", false),
    ];
    provider.accounts = vec![account, key_account("plain", "普通号", Some("sk-plain"))];
    service.add_provider(provider).unwrap();
    let provider = service.get_provider("p1").unwrap();

    let resolved = service
        .resolve_launch_env(&provider, Some("work"), "claude")
        .unwrap();
    assert_eq!(
        resolved.env_map(),
        HashMap::from([
            // 供应商层盖掉自动生成的地址
            (
                "ANTHROPIC_BASE_URL".to_string(),
                "https://provider.example".to_string()
            ),
            // 账号层盖掉自动生成的密钥
            (
                "ANTHROPIC_API_KEY".to_string(),
                "sk-account-override".to_string()
            ),
            // 账号层盖掉供应商层
            ("SHARED".to_string(), "from-account".to_string()),
            ("PROVIDER_ONLY".to_string(), "p".to_string()),
            ("ACCOUNT_ONLY".to_string(), "a".to_string()),
        ])
    );
    let layer_of = |name: &str| {
        let var = resolved.vars.iter().find(|var| var.name == name).unwrap();
        (var.layer, var.overrides)
    };
    assert_eq!(
        layer_of("ANTHROPIC_BASE_URL"),
        (
            ProviderEnvLayer::Provider,
            Some(ProviderEnvLayer::Generated)
        )
    );
    assert_eq!(
        layer_of("SHARED"),
        (ProviderEnvLayer::Account, Some(ProviderEnvLayer::Provider))
    );
    assert_eq!(
        layer_of("PROVIDER_ONLY"),
        (ProviderEnvLayer::Provider, None)
    );
    // 「用户填的」单独一组（启动时在适配器注入之后再盖一遍）。
    assert_eq!(resolved.custom_env_map().len(), 5);

    // 另一个账号：没有账号层，自动生成的密钥、供应商层的地址。
    let plain = service
        .resolve_launch_env(&provider, Some("plain"), "claude")
        .unwrap()
        .env_map();
    assert_eq!(plain["ANTHROPIC_API_KEY"], "sk-plain");
    assert_eq!(plain["ANTHROPIC_BASE_URL"], "https://provider.example");
    assert_eq!(plain["SHARED"], "from-provider");
    assert!(!plain.contains_key("ACCOUNT_ONLY"));
}

#[test]
fn unspecified_account_uses_the_default_and_unknown_account_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let service = owner(&dir, &memory_store());
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.accounts = vec![
        key_account("work", "工作号", Some("sk-work")),
        key_account("home", "个人号", Some("sk-home")),
    ];
    provider.default_account_id = Some("home".to_string());
    service.add_provider(provider).unwrap();
    let provider = service.get_provider("p1").unwrap();

    let default = service
        .resolve_launch_env(&provider, None, "claude")
        .unwrap();
    assert_eq!(default.account_id.as_deref(), Some("home"));
    assert_eq!(default.env_map()["ANTHROPIC_API_KEY"], "sk-home");

    let explicit = service
        .resolve_launch_env(&provider, Some("work"), "claude")
        .unwrap();
    assert_eq!(explicit.env_map()["ANTHROPIC_API_KEY"], "sk-work");

    let error = service
        .resolve_launch_env(&provider, Some("missing"), "claude")
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<AppError>().and_then(|e| e.code()),
        Some("PROVIDER_ACCOUNT_NOT_FOUND")
    );
}

#[test]
fn login_accounts_point_each_cli_at_its_directory_without_any_key() {
    let cases = [
        ("claude", ProviderType::Anthropic, "CLAUDE_CONFIG_DIR"),
        ("codex", ProviderType::OpenAI, "CODEX_HOME"),
        ("gemini", ProviderType::Gemini, "GEMINI_CLI_HOME"),
        ("antigravity", ProviderType::Gemini, "GEMINI_HOME"),
        ("grok", ProviderType::Grok, "GROK_HOME"),
    ];
    for (cli_tool, provider_type, dir_var) in cases {
        let dir = tempfile::tempdir().unwrap();
        let service = owner(&dir, &memory_store());
        let account_dir = dir.path().join(format!("accounts-{cli_tool}"));
        let account_dir = account_dir.to_string_lossy().to_string();
        let mut provider = new_provider("p1", provider_type);
        // 同一个供应商下还有一个带密钥的账号：登录账号启动时不能把它的密钥带出来。
        provider.accounts = vec![
            key_account("key", "密钥号", Some("sk-MUST-NOT-LEAK")),
            login_account("login", cli_tool, &account_dir),
        ];
        service.add_provider(provider).unwrap();
        let provider = service.get_provider("p1").unwrap();

        let resolved = service
            .resolve_launch_env(&provider, Some("login"), cli_tool)
            .unwrap();
        let env = resolved.env_map();

        assert_eq!(
            env.get(dir_var),
            Some(&account_dir),
            "{cli_tool} must get {dir_var}"
        );
        assert_eq!(resolved.config_dir.as_deref(), Some(account_dir.as_str()));
        assert_eq!(resolved.api_key, None, "{cli_tool} login must carry no key");
        assert!(
            !env.values().any(|value| value.contains("sk-MUST-NOT-LEAK")),
            "{cli_tool} login leaked a key"
        );
        assert!(
            !env.keys().any(|name| name.ends_with("_API_KEY")),
            "{cli_tool} login must not inject key variables: {env:?}"
        );
        // 只带这一个目录变量，不会顺手带上别的 CLI 的。
        for (_, _, other) in cases.iter().filter(|(_, _, other)| *other != dir_var) {
            assert!(!env.contains_key(*other));
        }
        // 登录账号没有钥匙串条目可推。
        assert!(service
            .launch_secret_entries(&provider, Some("login"))
            .unwrap()
            .is_empty());
        // 这个账号属于别的 CLI 时，不带目录变量。
        let other_cli = if cli_tool == "claude" {
            "codex"
        } else {
            "claude"
        };
        let other = service
            .resolve_launch_env(&provider, Some("login"), other_cli)
            .unwrap();
        assert!(!other.env_map().contains_key(dir_var));
        assert_eq!(other.config_dir, None);
    }
}

#[test]
fn login_accounts_are_limited_to_the_five_supported_clis() {
    let dir = tempfile::tempdir().unwrap();
    let service = owner(&dir, &memory_store());
    let mut provider = new_provider("p1", ProviderType::Kimi);
    provider.accounts = vec![login_account("login", "kimi", "/tmp/kimi-account")];

    assert!(service.add_provider(provider).is_err());
}

#[test]
fn endpoints_are_picked_per_cli() {
    let mut provider = new_provider("p1", ProviderType::LocalGateway);
    provider.endpoints = ProviderEndpoints {
        anthropic: Some("https://gw.example/anthropic".to_string()),
        chat: Some("https://gw.example/v1".to_string()),
        responses: Some("https://gw.example/codex/v1".to_string()),
        gemini: Some("https://gw.example/gemini".to_string()),
    };
    let pick = |provider: &Provider, cli: &str| {
        provider
            .endpoint_for_cli(cli)
            .map(|(kind, url)| (kind, url.to_string()))
    };

    assert_eq!(
        pick(&provider, "claude"),
        Some((
            EndpointKind::Anthropic,
            "https://gw.example/anthropic".to_string()
        ))
    );
    assert_eq!(
        pick(&provider, "jcode").map(|(kind, _)| kind),
        Some(EndpointKind::Anthropic)
    );
    assert_eq!(
        pick(&provider, "codex"),
        Some((
            EndpointKind::Responses,
            "https://gw.example/codex/v1".to_string()
        ))
    );
    assert_eq!(
        pick(&provider, "gemini"),
        Some((
            EndpointKind::Gemini,
            "https://gw.example/gemini".to_string()
        ))
    );
    assert_eq!(
        pick(&provider, "antigravity").map(|(kind, _)| kind),
        Some(EndpointKind::Gemini)
    );
    assert_eq!(
        pick(&provider, "kimi").map(|(kind, _)| kind),
        Some(EndpointKind::Chat)
    );
    assert_eq!(
        pick(&provider, "grok").map(|(kind, _)| kind),
        Some(EndpointKind::Chat)
    );
    assert_eq!(pick(&provider, "cursor"), None);

    // Codex 显式要 chat 时取 Chat 接口。
    provider.codex_wire_api = Some("chat".to_string());
    assert_eq!(
        pick(&provider, "codex").map(|(kind, _)| kind),
        Some(EndpointKind::Chat)
    );

    // 本机网关按目标 CLI 的原生变量注入各自的地址。
    provider.codex_wire_api = None;
    let account = key_account("a", "a", None);
    let names = |cli: &str| -> HashMap<String, String> {
        provider
            .generated_env(cli, &account, Some("gw-key"))
            .into_iter()
            .map(|(name, value, _)| (name, value))
            .collect()
    };
    assert_eq!(
        names("claude")["ANTHROPIC_BASE_URL"],
        "https://gw.example/anthropic"
    );
    assert_eq!(
        names("codex")["OPENAI_BASE_URL"],
        "https://gw.example/codex/v1"
    );
    assert_eq!(
        names("gemini")["GEMINI_API_BASE"],
        "https://gw.example/gemini"
    );
}

#[test]
fn missing_endpoint_falls_back_within_openai_family_only() {
    // 只填了 Chat：Codex 回退到它，并自动改用 chat wire API。
    let mut provider = new_provider("p1", ProviderType::OpenAI);
    provider.endpoints.chat = Some("https://relay.example/v1".to_string());
    assert_eq!(
        provider.endpoint_for_cli("codex"),
        Some((EndpointKind::Chat, "https://relay.example/v1"))
    );
    assert_eq!(provider.effective_codex_wire_api().as_deref(), Some("chat"));

    // 只填了 Responses：缺省 wire API（responses）。
    let mut provider = new_provider("p2", ProviderType::OpenAI);
    provider.endpoints.responses = Some("https://api.example/v1".to_string());
    assert_eq!(provider.effective_codex_wire_api(), None);
    assert_eq!(
        provider.endpoint_for_cli("kimi"),
        Some((EndpointKind::Responses, "https://api.example/v1"))
    );

    // Anthropic / Gemini 不回退：没填就不注入地址（CLI 用它自己的默认地址），密钥照带。
    assert_eq!(provider.endpoint_for_cli("claude"), None);
    assert_eq!(provider.endpoint_for_cli("gemini"), None);
    let mut anthropic = new_provider("p3", ProviderType::Anthropic);
    anthropic.endpoints.chat = Some("https://relay.example/v1".to_string());
    let account = key_account("a", "a", None);
    let generated = anthropic.generated_env("claude", &account, Some("sk-x"));
    assert_eq!(
        generated,
        vec![("ANTHROPIC_API_KEY".to_string(), "sk-x".to_string(), true)]
    );
}

#[test]
fn preview_masks_sensitive_values_and_never_reads_the_credential_store() {
    let dir = tempfile::tempdir().unwrap();
    // 读取一律失败的钥匙串：预览仍然要能出结果，说明它没有去读。
    let store = Arc::new(ProviderSecretStore::with_backend(Arc::new(
        UnreadableSecrets,
    )));
    let service = owner(&dir, &store);
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.endpoints.anthropic = Some("https://api.example.com".to_string());
    provider.env = vec![
        env_var("API_TIMEOUT_MS", "600000", false),
        env_var("ANTHROPIC_BASE_URL", "https://override.example", false),
        env_var("EXTRA_TOKEN", "extra-SECRET", true),
    ];
    provider.accounts = vec![key_account("work", "工作号", Some("sk-work-SECRET"))];
    service.add_provider(provider).unwrap();

    let preview = service.preview_env("p1", None, Some("claude")).unwrap();

    let entry = |name: &str| preview.iter().find(|entry| entry.name == name).unwrap();
    assert_eq!(entry("ANTHROPIC_API_KEY").value, MASKED_SECRET);
    assert!(entry("ANTHROPIC_API_KEY").sensitive);
    assert_eq!(
        entry("ANTHROPIC_API_KEY").layer,
        ProviderEnvLayer::Generated
    );
    assert_eq!(entry("EXTRA_TOKEN").value, MASKED_SECRET);
    assert_eq!(entry("API_TIMEOUT_MS").value, "600000");
    assert!(!entry("API_TIMEOUT_MS").overrides_generated);
    assert_eq!(
        entry("ANTHROPIC_BASE_URL").value,
        "https://override.example"
    );
    assert!(entry("ANTHROPIC_BASE_URL").overrides_generated);
    let serialized = serde_json::to_string(&preview).unwrap();
    assert!(!serialized.contains("SECRET"));

    // 不指定 CLI 时按供应商类型的原生 CLI 预览；系统条目没有可注入的东西。
    assert_eq!(service.preview_env("p1", None, None).unwrap(), preview);
    assert!(service
        .preview_env(SYSTEM_PROVIDER_ID, None, None)
        .unwrap()
        .is_empty());
}

#[test]
fn api_credentials_are_read_per_account() {
    let dir = tempfile::tempdir().unwrap();
    let service = owner(&dir, &memory_store());
    let mut provider = new_provider("p1", ProviderType::OpenAI);
    provider.endpoints.responses = Some("https://api.example/v1".to_string());
    provider.accounts = vec![
        key_account("work", "工作号", Some("sk-work")),
        key_account("home", "个人号", Some("sk-home")),
    ];
    service.add_provider(provider).unwrap();

    let default = service.resolve_api_credentials("p1", None).unwrap();
    assert_eq!(default.api_key.as_deref(), Some("sk-work"));
    assert_eq!(default.base_url.as_deref(), Some("https://api.example/v1"));
    let home = service.resolve_api_credentials("p1", Some("home")).unwrap();
    assert_eq!(home.api_key.as_deref(), Some("sk-home"));
}

#[test]
fn new_fields_are_backward_compatible_with_old_data() {
    // 旧数据缺所有新字段：能读，默认值合理。
    let provider: Provider = serde_json::from_value(json!({
        "id": "legacy",
        "name": "Legacy",
        "providerType": "anthropic",
        "isDefault": false
    }))
    .unwrap();
    assert!(provider.endpoints.is_empty());
    assert!(provider.env.is_empty());
    assert!(provider.accounts.is_empty());
    assert_eq!(provider.default_account_id, None);
    assert_eq!(provider.source, None);

    // 新枚举值与来源信息可以往返。
    let gateway: Provider = serde_json::from_value(json!({
        "id": "gw",
        "name": "magpie",
        "providerType": "local_gateway",
        "isDefault": false,
        "source": {
            "kind": "local_gateway",
            "externalId": "magpie",
            "importedAt": "2026-11-21T08:00:00Z",
            "fingerprint": "abc123"
        }
    }))
    .unwrap();
    assert_eq!(gateway.provider_type, ProviderType::LocalGateway);
    let value = serde_json::to_value(&gateway).unwrap();
    assert_eq!(value["providerType"], "local_gateway");
    assert_eq!(value["source"]["kind"], "local_gateway");
    assert_eq!(value["source"]["fingerprint"], "abc123");
}

#[test]
fn legacy_client_switching_between_config_dir_and_key_types_converts_the_default_account() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);
    let profile_dir = dir.path().join("claude-work");
    std::fs::create_dir_all(&profile_dir).unwrap();
    let profile_dir = profile_dir.to_string_lossy().to_string();

    // 旧界面建一个「配置目录」类型：默认账号是 Claude 登录账号。
    let mut provider = new_provider("p1", ProviderType::ConfigProfile);
    provider.config_dir = Some(profile_dir.clone());
    service.add_provider(provider).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(saved.accounts[0].kind, AccountKind::Login);
    assert_eq!(saved.accounts[0].cli_tool.as_deref(), Some("claude"));
    assert_eq!(saved.config_dir.as_deref(), Some(profile_dir.as_str()));

    // 旧界面把它改成带密钥的类型：默认账号变成密钥账号，目录不再残留。
    let mut edited = new_provider("p1", ProviderType::Anthropic);
    edited.api_key = Some("sk-switched".to_string());
    service.update_provider(edited).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(saved.accounts[0].kind, AccountKind::ApiKey);
    assert_eq!(saved.accounts[0].config_dir, None);
    assert_eq!(saved.config_dir, None);
    let env = service.get_env_vars(Some("p1"));
    assert_eq!(env["ANTHROPIC_API_KEY"], "sk-switched");
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR"));

    // 再改回「配置目录」：变回登录账号，原来的密钥从钥匙串里删掉。
    let mut edited = new_provider("p1", ProviderType::ConfigProfile);
    edited.config_dir = Some(profile_dir.clone());
    service.update_provider(edited).unwrap();
    let saved = service.get_provider("p1").unwrap();
    assert_eq!(saved.accounts[0].kind, AccountKind::Login);
    assert_eq!(
        store
            .load(&account_secret_key("p1", DEFAULT_ACCOUNT_ID))
            .unwrap(),
        None
    );
    assert_eq!(
        service.get_env_vars(Some("p1")),
        HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), profile_dir)])
    );
}

#[test]
fn a_failed_save_restores_the_previous_secret_instead_of_deleting_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = memory_store();
    let service = owner(&dir, &store);
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.accounts = vec![key_account("work", "工作号", Some("sk-original"))];
    service.add_provider(provider).unwrap();
    let before = read_file(&dir);

    // 换密钥的同时把配置撑过大小上限：钥匙串已经写了新值，但文件落盘失败。
    let mut edited = service.get_provider_for_display("p1").unwrap();
    edited.accounts[0].secret = Some("sk-rotated".to_string());
    edited.env = (0..MAX_CONFIG_ENV_ITEMS)
        .map(|index| env_var(&format!("BIG_{index}"), &"x".repeat(60_000), false))
        .collect();
    assert!(service.update_provider(edited).is_err());

    assert_eq!(read_file(&dir), before);
    assert_eq!(
        store
            .load(&account_secret_key("p1", "work"))
            .unwrap()
            .as_deref(),
        Some("sk-original"),
        "the previous key must survive a failed save"
    );
    assert_eq!(
        service.get_env_vars(Some("p1"))["ANTHROPIC_API_KEY"],
        "sk-original"
    );
}

#[test]
fn debug_output_never_contains_secret_values() {
    let dir = tempfile::tempdir().unwrap();
    // 没有钥匙串：内存里的账号上带着明文，最容易随 `{:?}` 漏进日志。
    let service = ProviderService::new(providers_path(&dir));
    let mut provider = new_provider("p1", ProviderType::Anthropic);
    provider.env = vec![env_var("EXTRA_TOKEN", "env-SECRET-value", true)];
    provider.accounts = vec![key_account("work", "工作号", Some("sk-SECRET-value"))];
    service.add_provider(provider).unwrap();
    let provider = service.get_provider("p1").unwrap();
    assert_eq!(
        provider.accounts[0].secret.as_deref(),
        Some("sk-SECRET-value")
    );

    let resolved = service
        .resolve_launch_env(&provider, None, "claude")
        .unwrap();

    for printed in [
        format!("{provider:?}"),
        format!("{resolved:?}"),
        format!("{:?}", resolved.vars),
    ] {
        assert!(!printed.contains("SECRET-value"), "leaked: {printed}");
    }
}
