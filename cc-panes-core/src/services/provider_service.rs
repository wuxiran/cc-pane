mod account_ops;
#[cfg(test)]
mod account_tests;
mod accounts;
mod env;
mod migration;

pub use env::{
    ProviderApiCredentials, ProviderEnvLayer, ProviderEnvPreviewEntry, ProviderLaunchEnv,
    ResolvedEnvVar, MASKED_SECRET,
};

use crate::models::provider::{
    AccountKind, Provider, ProviderAccount, ProviderConfig, ProviderModel, ProviderType,
    SystemProviderInfo, PROVIDER_SCHEMA_VERSION, SYSTEM_PROVIDER_ID,
};
use crate::services::cc_switch_import::{
    candidate_to_provider, cc_switch_db_path, load_cc_switch_providers, CcSwitchImportReport,
};
use crate::services::external_provider_import::{
    default_source_path, is_same_provider, load_external_batch, primary_url,
    ExternalProviderCandidateView, ExternalProviderPreview, ExternalProviderSource,
};
use crate::services::provider_secret_service::ProviderSecretStore;
use crate::utils::{error::AppError, error_codes as EC};
use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use tracing::warn;

/// 宿主环境中被视为「已配置 Anthropic 凭证」的环境变量。
const SYSTEM_PROBE_ENV_KEYS: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];
pub(super) const MAX_PROVIDER_CONFIG_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_PROVIDER_ID_CHARS: usize = 128;
pub(super) const MAX_PROVIDER_NAME_CHARS: usize = 200;
pub(super) const MAX_PROVIDER_URL_CHARS: usize = 4096;
pub(super) const MAX_PROVIDER_SECRET_CHARS: usize = 65_536;
pub(super) const MAX_PROVIDER_FIELD_CHARS: usize = 4096;
pub(super) const MAX_CONFIG_ENV_ITEMS: usize = 64;
pub(super) const MAX_PROVIDER_COUNT: usize = 256;
const MAX_PROVIDER_MODELS: usize = 100;
const MAX_PROVIDER_MODEL_ID_CHARS: usize = 256;
const MAX_PROVIDER_MODEL_LABEL_CHARS: usize = 128;
const MIN_PROVIDER_CONTEXT_WINDOW_TOKENS: u64 = 1_000;
const MAX_PROVIDER_CONTEXT_WINDOW_TOKENS: u64 = 10_000_000;
const PROVIDER_MODEL_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
pub(super) const PROVIDER_CLI_TOOLS: [&str; 8] = [
    "claude", "codex", "gemini", "kimi", "opencode", "cursor", "grok", "pi",
];
const DEFAULT_PROVIDER_IDS_VERSION: u8 = 2;

/// Provider 服务 - 管理 AI Provider 配置
pub struct ProviderService {
    config_path: PathBuf,
    config: Mutex<ProviderConfig>,
    /// 密钥存储（系统钥匙串，或测试 / 无钥匙串环境下的替身）。
    secrets: Arc<ProviderSecretStore>,
    /// 这个进程是否负责迁移与落盘。daemon 是「跟随者」：只读，按新结构在内存里解析。
    owns_storage: bool,
    /// 本进程里迁移落盘失败过：不再反复重试，下次启动再试。
    migration_failed: AtomicBool,
}

impl ProviderService {
    /// 不接钥匙串的构造：密钥留在文件里并标 `file`（「未进钥匙串」）。
    ///
    /// 供测试和没有钥匙串的场景用——它**不会**碰系统钥匙串。生产进程请用
    /// [`ProviderService::with_secret_store`]（主程序 / cc-panes-web）或
    /// [`ProviderService::follower`]（daemon）。
    pub fn new(config_path: PathBuf) -> Self {
        Self::with_secret_store(config_path, Arc::new(ProviderSecretStore::unavailable()))
    }

    /// 拥有者：负责旧数据迁移、把密钥写进钥匙串、落盘。
    pub fn with_secret_store(config_path: PathBuf, secrets: Arc<ProviderSecretStore>) -> Self {
        Self::build(config_path, secrets, true)
    }

    /// 跟随者（daemon）：只读 `providers.json`，不迁移、不写钥匙串。
    /// 密钥来自主程序推过来的临时值（见 `ProviderSecretStore::set_temporary`）。
    pub fn follower(config_path: PathBuf, secrets: Arc<ProviderSecretStore>) -> Self {
        Self::build(config_path, secrets, false)
    }

    fn build(config_path: PathBuf, secrets: Arc<ProviderSecretStore>, owns_storage: bool) -> Self {
        let service = Self {
            config_path,
            config: Mutex::new(ProviderConfig::default()),
            secrets,
            owns_storage,
            migration_failed: AtomicBool::new(false),
        };
        let config = service.load_at_startup().unwrap_or_default();
        *service.config.lock().unwrap_or_else(|e| e.into_inner()) = config;
        service
    }

    /// `providers.json` 的路径（它所在的目录就是数据目录）。
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// 密钥存储。主程序用它读出要推给 daemon 的值；daemon 用它接收。
    pub fn secret_store(&self) -> &Arc<ProviderSecretStore> {
        &self.secrets
    }

    /// 当前环境有没有可用的钥匙串（界面据此提示「未进钥匙串」）。
    pub fn keychain_available(&self) -> bool {
        self.secrets.is_available()
    }

    fn commit_config(&self, current: &mut ProviderConfig, next: ProviderConfig) -> Result<()> {
        let mut next = next;
        // One boundary for all mutations: reject growth beyond the limit without
        // blocking edits/removals that let legacy oversized configurations recover.
        if next.providers.len() > MAX_PROVIDER_COUNT
            && next.providers.len() > current.providers.len()
        {
            anyhow::bail!("providers config exceeds {} entries", MAX_PROVIDER_COUNT);
        }
        next.default_provider_ids_version = DEFAULT_PROVIDER_IDS_VERSION;
        next.schema_version = PROVIDER_SCHEMA_VERSION;
        Self::sync_legacy_default_flags(&mut next);
        // 新输入的密钥先进钥匙串，再写文件；写文件失败则撤回本次新写的条目。
        let mut written = Vec::new();
        let result = next
            .providers
            .iter_mut()
            .try_for_each(|provider| self.externalize_secrets(provider, &mut written))
            .and_then(|()| self.save_to_file(&next));
        if let Err(error) = result {
            self.rollback_secrets(&written);
            return Err(error);
        }
        // 不再被引用的钥匙串条目（删了账号 / 清了密钥 / 删了供应商）一并清掉。
        let kept = Self::keychain_keys(&next);
        for key in Self::keychain_keys(current).difference(&kept) {
            if let Err(error) = self.secrets.delete(key) {
                warn!(error = %error, "[ProviderService] Failed to delete an unused provider secret");
            }
        }
        *current = next;
        Ok(())
    }

    fn migrate_legacy_defaults(config: &mut ProviderConfig) {
        if config.default_provider_ids_version < DEFAULT_PROVIDER_IDS_VERSION {
            if config.default_provider_ids.is_empty() {
                if config.default_is_system {
                    config
                        .default_provider_ids
                        .insert("claude".to_string(), SYSTEM_PROVIDER_ID.to_string());
                } else if let Some(provider) =
                    config.providers.iter().find(|provider| provider.is_default)
                {
                    config.default_provider_ids.insert(
                        Self::native_cli_for_provider_type(provider.provider_type).to_string(),
                        provider.id.clone(),
                    );
                }
            } else {
                let provider_types: HashMap<_, _> = config
                    .providers
                    .iter()
                    .map(|provider| (provider.id.clone(), provider.provider_type))
                    .collect();
                config.default_provider_ids.retain(|cli_tool, provider_id| {
                    if provider_id == SYSTEM_PROVIDER_ID {
                        return cli_tool == "claude";
                    }
                    provider_types
                        .get(provider_id)
                        .is_some_and(|provider_type| {
                            Self::native_cli_for_provider_type(*provider_type) == cli_tool
                        })
                });
            }
            config.default_provider_ids_version = DEFAULT_PROVIDER_IDS_VERSION;
        }
        Self::sync_legacy_default_flags(config);
    }

    fn native_cli_for_provider_type(provider_type: ProviderType) -> &'static str {
        match provider_type {
            ProviderType::Anthropic
            | ProviderType::Bedrock
            | ProviderType::Vertex
            | ProviderType::Proxy
            | ProviderType::ConfigProfile
            | ProviderType::LocalGateway => "claude",
            ProviderType::OpenAI => "codex",
            ProviderType::Gemini => "gemini",
            ProviderType::Kimi => "kimi",
            ProviderType::OpenCode => "opencode",
            ProviderType::Cursor => "cursor",
            ProviderType::Grok => "grok",
            // Media 不属于任何 CLI；已被加载层清洗丢弃（老数据 provider_type="media" 不会进入此逻辑）。
        }
    }

    fn sync_legacy_default_flags(config: &mut ProviderConfig) {
        config.default_is_system = config
            .default_provider_ids
            .values()
            .any(|id| id == SYSTEM_PROVIDER_ID);
        for provider in &mut config.providers {
            provider.is_default = config
                .default_provider_ids
                .values()
                .any(|id| id == &provider.id);
        }
    }

    fn validate_cli_tool(cli_tool: &str) -> Result<()> {
        if PROVIDER_CLI_TOOLS.contains(&cli_tool) {
            Ok(())
        } else {
            anyhow::bail!("Unsupported CLI tool '{}'", cli_tool)
        }
    }

    fn refresh_locked(&self, cached: &mut ProviderConfig) {
        if !self.config_path.is_file() {
            return;
        }

        match self.load_and_migrate() {
            Ok(config) => {
                *cached = config;
            }
            Err(error) => {
                warn!(
                    path = %self.config_path.display(),
                    error = %error,
                    "[ProviderService] Failed to refresh providers config; keeping cached snapshot"
                );
            }
        }
    }

    /// Refresh the in-memory snapshot before reads.
    ///
    /// The desktop process and the long-lived daemon each own a separate
    /// `ProviderService`. Provider edits are written atomically, so re-reading
    /// here makes the next operation observe them without requiring an
    /// application or daemon restart.
    fn refresh_from_file(&self) {
        let mut cached = self.config.lock().unwrap_or_else(|e| e.into_inner());
        self.refresh_locked(&mut cached);
    }

    /// Lock the local snapshot and reload the latest on-disk configuration
    /// before applying a read-modify-write operation.
    fn lock_latest_config(&self) -> MutexGuard<'_, ProviderConfig> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        self.refresh_locked(&mut config);
        config
    }

    /// 列出所有 Provider
    pub fn list_providers(&self) -> Vec<Provider> {
        self.refresh_from_file();
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .providers
            .clone()
    }

    /// 获取指定 Provider
    pub fn get_provider(&self, id: &str) -> Option<Provider> {
        self.refresh_from_file();
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// 获取默认 Provider
    pub fn get_default_provider(&self) -> Option<Provider> {
        self.refresh_from_file();
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        config
            .providers
            .iter()
            .find(|p| p.is_default)
            .or_else(|| config.providers.first())
            .cloned()
    }

    /// 给界面 / REST 的列表：清掉一切密钥与敏感值明文，只留「有没有、存在哪」的标记。
    /// 命令层和路由层一律用这一组，不要把 [`ProviderService::list_providers`] 的结果直接交出去
    /// ——没有钥匙串的环境下它带着文件里的明文。
    pub fn list_providers_for_display(&self) -> Vec<Provider> {
        self.list_providers()
            .into_iter()
            .map(Provider::redacted)
            .collect()
    }

    pub fn get_provider_for_display(&self, id: &str) -> Option<Provider> {
        self.get_provider(id).map(Provider::redacted)
    }

    pub fn get_default_provider_for_display(&self) -> Option<Provider> {
        self.get_default_provider().map(Provider::redacted)
    }

    /// 获取指定 CLI 工具的持久化默认 id。`__system__` 也会原样返回。
    pub fn get_default_provider_id(&self, cli_tool: &str) -> Option<String> {
        self.refresh_from_file();
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .default_provider_ids
            .get(cli_tool)
            .cloned()
    }

    /// 获取指定 CLI 工具的默认托管 Provider；系统默认返回 `None`。
    pub fn get_default_provider_for_cli(&self, cli_tool: &str) -> Option<Provider> {
        let id = self.get_default_provider_id(cli_tool)?;
        if id == SYSTEM_PROVIDER_ID {
            return None;
        }
        self.get_provider(&id)
    }

    /// 检测「系统环境变量」provider 是否应可用/默认。
    ///
    /// 判据（满足其一即为真）：
    /// 1. 检测到 cc-switch：`~/.cc-switch/cc-switch.db` 存在；
    /// 2. 宿主环境已设置 Anthropic 凭证：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
    ///    `ANTHROPIC_BASE_URL` 之一非空。
    ///
    /// 为真时前端会把「系统环境变量」作为默认选项——即不注入、跟随宿主/cc-switch。
    pub fn system_provider_active() -> bool {
        let (cc_switch, env_keys) = Self::probe_system_provider();
        cc_switch || !env_keys.is_empty()
    }

    /// 探测明细：(是否检测到 cc-switch, 命中的宿主环境变量名列表)。
    fn probe_system_provider() -> (bool, Vec<String>) {
        let cc_switch = dirs::home_dir()
            .map(|h| h.join(".cc-switch").join("cc-switch.db"))
            .map(|p| p.is_file())
            .unwrap_or(false);

        let env_keys = SYSTEM_PROBE_ENV_KEYS
            .iter()
            .filter(|key| std::env::var(key).map(|v| !v.is_empty()).unwrap_or(false))
            .map(|key| key.to_string())
            .collect();

        (cc_switch, env_keys)
    }

    /// 探测结果 + 当前「系统条目是否为默认」的持久化状态。
    ///
    /// 只回传命中的**变量名**，绝不回传值——凭证不出后端。
    pub fn system_provider_info(&self) -> SystemProviderInfo {
        let (cc_switch, env_keys) = Self::probe_system_provider();
        self.refresh_from_file();
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let default_is_system = config.default_is_system;
        let default_provider_ids = config.default_provider_ids.clone();

        SystemProviderInfo {
            active: cc_switch || !env_keys.is_empty(),
            cc_switch,
            env_keys,
            default_is_system,
            default_provider_ids,
        }
    }

    /// 添加 Provider
    pub fn add_provider(&self, mut provider: Provider) -> Result<()> {
        // `__system__` 是合成「系统环境变量」条目的保留 id，禁止落盘，
        // 否则会与列表顶部的虚拟条目撞 id、且凭证永远被 get_env_vars 短路忽略。
        Self::normalize_provider_models(&mut provider)?;
        Self::normalize_accounts(&mut provider, None, false)?;
        Self::validate_provider(&provider)?;

        let mut config = self.lock_latest_config();
        if config.providers.iter().any(|item| item.id == provider.id) {
            anyhow::bail!("Provider id '{}' already exists", provider.id);
        }
        let mut next = config.clone();

        let requested_as_default = provider.is_default;
        provider.is_default = false;

        let default_cli = Self::native_cli_for_provider_type(provider.provider_type);
        let provider_id = provider.id.clone();
        next.providers.push(provider);
        if requested_as_default || !next.default_provider_ids.contains_key(default_cli) {
            next.default_provider_ids
                .insert(default_cli.to_string(), provider_id);
        }
        self.commit_config(&mut config, next)
    }

    /// 原子去重添加（供一键导入）：在**同一把锁**内检查 name+type+base_url 是否已存在，
    /// 存在则报错、否则插入。避免并发导入「各自 list→都通过→都 insert」堆重复。
    pub fn add_provider_unique(&self, mut provider: Provider) -> Result<()> {
        Self::normalize_provider_models(&mut provider)?;
        Self::normalize_accounts(&mut provider, None, false)?;
        Self::validate_provider(&provider)?;
        let mut config = self.lock_latest_config();
        if config.providers.iter().any(|item| item.id == provider.id) {
            anyhow::bail!("Provider id '{}' already exists", provider.id);
        }
        let dup = config.providers.iter().any(|e| {
            e.name == provider.name
                && e.provider_type == provider.provider_type
                && e.base_url == provider.base_url
        });
        if dup {
            anyhow::bail!("已存在同名同端点的 provider：{}", provider.name);
        }
        let mut next = config.clone();
        let requested_as_default = provider.is_default;
        provider.is_default = false;
        let default_cli = Self::native_cli_for_provider_type(provider.provider_type);
        let provider_id = provider.id.clone();
        next.providers.push(provider);
        if requested_as_default || !next.default_provider_ids.contains_key(default_cli) {
            next.default_provider_ids
                .insert(default_cli.to_string(), provider_id);
        }
        self.commit_config(&mut config, next)
    }

    /// 从 cc-switch 数据库抄入供应商。已存在（同名+类型+端点）的跳过，不改默认项。
    pub fn import_cc_switch_providers(
        &self,
        db_path: Option<&Path>,
    ) -> Result<CcSwitchImportReport> {
        let owned = db_path.map(Path::to_path_buf).or_else(cc_switch_db_path);
        let path = owned.ok_or_else(|| anyhow::anyhow!("cc-switch database not found"))?;
        if !path.is_file() {
            anyhow::bail!("cc-switch database not found");
        }

        let batch = load_cc_switch_providers(&path)?;
        let mut report = CcSwitchImportReport {
            skipped_empty: batch.skipped_empty,
            skipped_unsupported: batch.skipped_unsupported,
            ..CcSwitchImportReport::default()
        };
        if batch.candidates.is_empty() {
            return Ok(report);
        }

        let mut config = self.lock_latest_config();
        let mut next = config.clone();
        for candidate in batch.candidates {
            let mut provider = candidate_to_provider(&candidate);
            Self::normalize_provider_models(&mut provider)?;
            Self::normalize_accounts(&mut provider, None, false)?;
            Self::validate_provider(&provider)?;
            if next.providers.iter().any(|existing| {
                existing.name == provider.name
                    && existing.provider_type == provider.provider_type
                    && existing.base_url == provider.base_url
            }) {
                report.skipped_duplicate += 1;
                continue;
            }
            if next.providers.len() >= MAX_PROVIDER_COUNT {
                anyhow::bail!("providers config exceeds {MAX_PROVIDER_COUNT} entries");
            }
            provider.is_default = false;
            next.providers.push(provider);
            report.imported += 1;
        }
        if report.imported > 0 {
            self.commit_config(&mut config, next)?;
        }
        Ok(report)
    }

    /// 预览外部来源（cc-switch / Magpie）里可导入的供应商；已存在的标 `duplicate`。不写任何东西。
    pub fn preview_external_providers(
        &self,
        source: ExternalProviderSource,
        path: Option<&Path>,
    ) -> Result<ExternalProviderPreview> {
        let Some(path) = path
            .map(Path::to_path_buf)
            .or_else(|| default_source_path(source))
        else {
            return Ok(ExternalProviderPreview::default());
        };
        if !path.is_file() {
            return Ok(ExternalProviderPreview {
                path: Some(path.display().to_string()),
                ..ExternalProviderPreview::default()
            });
        }
        let batch = load_external_batch(source, &path)?;
        let config = self.lock_latest_config();
        let candidates = batch
            .candidates
            .into_iter()
            .map(|candidate| {
                let provider = candidate.provider;
                let existing = config
                    .providers
                    .iter()
                    .find(|existing| is_same_provider(existing, &provider));
                let can_supplement_provider = existing.is_some_and(|existing| {
                    crate::services::external_provider_import::supplement_native_fields(
                        &mut existing.clone(),
                        &provider,
                    )
                });
                ExternalProviderCandidateView {
                    key: candidate.key,
                    base_url: primary_url(&provider),
                    has_key: provider.api_key.is_some(),
                    model_count: provider.models.len(),
                    has_provider_native_override: !provider.native_overrides.is_empty(),
                    context_window_tokens: provider
                        .models
                        .iter()
                        .find_map(|model| model.context_window_tokens),
                    name: provider.name,
                    provider_type: provider.provider_type,
                    duplicate: existing.is_some(),
                    existing_provider_id: existing.map(|existing| existing.id.clone()),
                    can_supplement_provider,
                    profile: candidate.profile,
                    relay: candidate.relay,
                }
            })
            .collect();
        Ok(ExternalProviderPreview {
            available: true,
            path: Some(path.display().to_string()),
            candidates,
            skipped_empty: batch.skipped_empty,
            skipped_unsupported: batch.skipped_unsupported,
            unsupported_logins: batch.unsupported_logins,
            skipped_items: batch.skipped_items,
        })
    }

    /// 从外部来源导入供应商。`keys` = 预览里勾选的键；`None` = 全部。已存在的跳过，不改默认项。
    pub fn import_external_providers(
        &self,
        source: ExternalProviderSource,
        keys: Option<&[String]>,
        path: Option<&Path>,
    ) -> Result<CcSwitchImportReport> {
        let path = path
            .map(Path::to_path_buf)
            .or_else(|| default_source_path(source))
            .filter(|path| path.is_file())
            .ok_or_else(|| anyhow::anyhow!("import source not found"))?;
        let batch = load_external_batch(source, &path)?;
        let mut report = CcSwitchImportReport {
            skipped_empty: batch.skipped_empty,
            skipped_unsupported: batch.skipped_unsupported,
            ..CcSwitchImportReport::default()
        };
        let mut config = self.lock_latest_config();
        let mut next = config.clone();
        for candidate in batch.candidates {
            if keys.is_some_and(|keys| !keys.iter().any(|key| key == &candidate.key)) {
                continue;
            }
            let mut provider = candidate.provider;
            if next
                .providers
                .iter()
                .any(|existing| is_same_provider(existing, &provider))
            {
                report.skipped_duplicate += 1;
                continue;
            }
            Self::normalize_provider_models(&mut provider)?;
            Self::normalize_accounts(&mut provider, None, false)?;
            Self::validate_provider(&provider)?;
            if next.providers.len() >= MAX_PROVIDER_COUNT {
                anyhow::bail!("providers config exceeds {MAX_PROVIDER_COUNT} entries");
            }
            provider.is_default = false;
            next.providers.push(provider);
            report.imported += 1;
        }
        if report.imported > 0 {
            self.commit_config(&mut config, next)?;
        }
        Ok(report)
    }

    /// 「补充原生配置」：对已存在的中转站，只把来源里的原生配置片段 / 模型上下文窗口
    /// 填进空着的位置，绝不覆盖用户已有的内容。`keys` = 预览里勾选的键。返回改动的中转站数。
    pub fn supplement_external_providers(
        &self,
        source: ExternalProviderSource,
        keys: &[String],
        path: Option<&Path>,
    ) -> Result<usize> {
        let path = path
            .map(Path::to_path_buf)
            .or_else(|| default_source_path(source))
            .filter(|path| path.is_file())
            .ok_or_else(|| anyhow::anyhow!("import source not found"))?;
        let batch = load_external_batch(source, &path)?;
        let mut config = self.lock_latest_config();
        let mut next = config.clone();
        let mut updated = 0;
        for candidate in batch.candidates {
            if !keys.iter().any(|key| key == &candidate.key) {
                continue;
            }
            let Some(existing) = next
                .providers
                .iter_mut()
                .find(|existing| is_same_provider(existing, &candidate.provider))
            else {
                continue;
            };
            if crate::services::external_provider_import::supplement_native_fields(
                existing,
                &candidate.provider,
            ) {
                existing.native_overrides = crate::services::native_config::normalize_overrides(
                    Some(std::mem::take(&mut existing.native_overrides)),
                )?;
                updated += 1;
            }
        }
        if updated > 0 {
            self.commit_config(&mut config, next)?;
        }
        Ok(updated)
    }

    /// 更新 Provider
    pub fn update_provider(&self, mut provider: Provider) -> Result<()> {
        // 同 add_provider：保留 id 不可写入 providers.json。
        Self::normalize_provider_models(&mut provider)?;

        let mut config = self.lock_latest_config();

        let pos = config
            .providers
            .iter()
            .position(|p| p.id == provider.id)
            .with_context(|| format!("Provider '{}' not found", provider.id))?;
        // 界面拿到的是清掉密钥明文的副本：已存的密钥标记 / 文件回退时的明文从旧条目承接。
        Self::normalize_accounts(&mut provider, Some(&config.providers[pos]), false)?;
        Self::validate_provider(&provider)?;
        // 来源标记不在编辑表单里：载荷没带就承接旧条目，编辑不抹掉「从哪导入」。
        if provider.source.is_none() {
            provider.source = config.providers[pos].source.clone();
        }
        // 旧界面 / 别的入口不带提醒开关保存时，沿用已存的选择。
        if provider.alerts.is_none() {
            provider.alerts = config.providers[pos].alerts;
        }
        let mut next = config.clone();

        if provider.is_default && !next.providers[pos].is_default {
            let default_cli = Self::native_cli_for_provider_type(provider.provider_type);
            next.default_provider_ids
                .insert(default_cli.to_string(), provider.id.clone());
        }
        provider.is_default = next
            .default_provider_ids
            .values()
            .any(|id| id == &provider.id);
        next.providers[pos] = provider;
        self.commit_config(&mut config, next)
    }

    /// 删除 Provider；对应 CLI 回到原生配置，避免静默切换到另一个凭证。
    pub fn remove_provider(&self, id: &str) -> Result<()> {
        let mut config = self.lock_latest_config();

        let mut next = config.clone();
        next.providers.retain(|p| p.id != id);
        next.default_provider_ids
            .retain(|_, default_id| default_id != id);
        self.commit_config(&mut config, next)
    }

    /// 兼容旧调用：只设置 Provider 的原生 CLI，避免隐式影响其它 CLI。
    pub fn set_default(&self, id: &str) -> Result<()> {
        let mut config = self.lock_latest_config();
        let is_system = id == SYSTEM_PROVIDER_ID;
        if !is_system && !config.providers.iter().any(|provider| provider.id == id) {
            anyhow::bail!("Provider '{}' not found", id);
        }
        let mut next = config.clone();
        let cli_tool = if is_system {
            "claude"
        } else {
            let provider = config
                .providers
                .iter()
                .find(|provider| provider.id == id)
                .expect("provider existence checked above");
            Self::native_cli_for_provider_type(provider.provider_type)
        };
        next.default_provider_ids
            .insert(cli_tool.to_string(), id.to_string());
        self.commit_config(&mut config, next)
    }

    /// 只设置一个 CLI 工具的默认 Provider，不影响其他 CLI。
    pub fn set_default_for_cli(&self, cli_tool: &str, id: &str) -> Result<()> {
        Self::validate_cli_tool(cli_tool)?;
        let mut config = self.lock_latest_config();
        if id != SYSTEM_PROVIDER_ID && !config.providers.iter().any(|provider| provider.id == id) {
            anyhow::bail!("Provider '{}' not found", id);
        }
        let mut next = config.clone();
        next.default_provider_ids
            .insert(cli_tool.to_string(), id.to_string());
        self.commit_config(&mut config, next)
    }

    /// 获取指定 Provider 的环境变量（核心方法）
    /// - 传入 provider_id 时使用该 Provider
    /// - provider_id 为 None 时不注入任何 env var，由调用方决定默认回退来源
    /// - 指定的 provider_id 找不到时返回空
    pub fn get_env_vars(&self, provider_id: Option<&str>) -> HashMap<String, String> {
        // 合成「系统环境变量」条目：显式不注入，跟随系统当前配置（如 cc-switch）。
        // 独立短路，避免下面走「provider not found」告警路径。
        if provider_id == Some(SYSTEM_PROVIDER_ID) {
            return HashMap::new();
        }

        self.refresh_from_file();

        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let provider = if let Some(id) = provider_id {
            config.providers.iter().find(|p| p.id == id)
        } else {
            // 无指定时不注入任何 Provider env var
            // 默认回退来源由调用方决定（例如 Windows 默认 .codex）
            return HashMap::new();
        };

        match provider {
            Some(p) => self.get_env_vars_for_provider(p),
            None => {
                warn!(
                    "[ProviderService] Provider '{}' not found, skipping env injection",
                    provider_id.unwrap_or("unknown")
                );
                HashMap::new()
            }
        }
    }

    /// 用默认账号、按供应商类型的原生 CLI 解析环境变量。
    ///
    /// 兼容旧调用方；启动路径请用 [`ProviderService::resolve_launch_env`]，
    /// 它能指定账号和目标 CLI，并且读不到密钥时会报错而不是静默返回空。
    pub fn get_env_vars_for_provider(&self, provider: &Provider) -> HashMap<String, String> {
        match self.resolve_launch_env(provider, None, Self::native_cli_for(provider)) {
            Ok(resolved) => resolved.env_map(),
            Err(error) => {
                warn!(
                    provider_id = %provider.id,
                    error = %error,
                    "[ProviderService] Failed to resolve provider environment"
                );
                HashMap::new()
            }
        }
    }

    /// 这条供应商配上这个账号，有没有可用的托管配置。
    pub(crate) fn managed_configuration_is_usable(
        provider: &Provider,
        account: &ProviderAccount,
    ) -> bool {
        let has_key = account.has_secret();
        let has_url = !provider.endpoints.is_empty();

        match provider.provider_type {
            ProviderType::Bedrock | ProviderType::Vertex => true,
            ProviderType::ConfigProfile => {
                let Some(config_path) = account.login_dir() else {
                    return false;
                };
                let path = Path::new(config_path);
                path.is_dir()
                    || (path.is_file()
                        && Self::parse_env_config_file(path).is_ok_and(|vars| !vars.is_empty()))
            }
            // 登录账号靠 CLI 自己的登录：有目录即可用，不要求密钥。
            // 合成的「默认登录」不带目录，用的是 CLI 默认目录里的那一套。
            _ if account.kind == AccountKind::Login => {
                account.login_dir().is_some() || account.is_default_login()
            }
            ProviderType::Cursor | ProviderType::Kimi => has_key,
            _ => has_key || has_url,
        }
    }

    /// 解析 ccswitch 格式的 JSON 配置文件
    /// 格式: { "env": { "KEY": "VALUE", ... } }
    fn parse_env_config_file(path: &Path) -> Result<HashMap<String, String>> {
        let size = path.metadata()?.len();
        if size > MAX_PROVIDER_CONFIG_BYTES {
            anyhow::bail!("配置文件超过 {} bytes", MAX_PROVIDER_CONFIG_BYTES);
        }
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("无法读取配置文件: {}", path.display()))?;

        let json: serde_json::Value = serde_json::from_str(&content)
            .with_context(|| format!("JSON 解析失败: {}", path.display()))?;

        let env_obj = match json.get("env").and_then(|v| v.as_object()) {
            Some(obj) => obj,
            None => {
                warn!(
                    "[ProviderService] Config file missing 'env' field: {}",
                    path.display()
                );
                return Ok(HashMap::new());
            }
        };
        if env_obj.len() > MAX_CONFIG_ENV_ITEMS {
            anyhow::bail!("配置文件 env 项超过 {}", MAX_CONFIG_ENV_ITEMS);
        }

        let mut vars = HashMap::new();
        for (key, value) in env_obj {
            if let Some(val_str) = value.as_str() {
                if !Self::valid_env_key(key) || val_str.chars().count() > MAX_PROVIDER_SECRET_CHARS
                {
                    continue;
                }
                vars.insert(key.clone(), val_str.to_string());
            }
        }

        Ok(vars)
    }

    fn normalize_provider_models(provider: &mut Provider) -> Result<()> {
        // 原生配置片段：去掉空白片段，校验其余（托管键 / 像密钥的键直接拒绝保存）。
        provider.native_overrides = crate::services::native_config::normalize_overrides(Some(
            std::mem::take(&mut provider.native_overrides),
        ))?;
        if provider.models.len() > MAX_PROVIDER_MODELS {
            return Err(Self::provider_model_error(
                EC::PROVIDER_MODEL_INVALID,
                format!(
                    "Provider model catalog exceeds {} entries",
                    MAX_PROVIDER_MODELS
                ),
            ));
        }

        let mut model_ids = HashSet::with_capacity(provider.models.len());
        for model in &mut provider.models {
            Self::normalize_provider_model(model)?;
            if !model_ids.insert(model.id.clone()) {
                return Err(Self::provider_model_error(
                    EC::PROVIDER_MODEL_DUPLICATE,
                    format!("Duplicate Provider model id '{}'", model.id),
                ));
            }
        }

        let explicit_default = provider
            .default_model_id
            .take()
            .map(|model_id| model_id.trim().to_string())
            .filter(|model_id| !model_id.is_empty());
        if let Some(default_model_id) = explicit_default.as_ref() {
            if !Self::valid_provider_model_id(default_model_id) {
                return Err(Self::provider_model_error(
                    EC::PROVIDER_MODEL_INVALID,
                    "Provider defaultModelId is invalid",
                ));
            }
            if !model_ids.contains(default_model_id) {
                return Err(Self::provider_model_error(
                    EC::PROVIDER_MODEL_INVALID,
                    "Provider defaultModelId is not present in models",
                ));
            }
        }
        provider.default_model_id =
            explicit_default.or_else(|| provider.models.first().map(|model| model.id.clone()));
        Ok(())
    }

    fn normalize_provider_model(model: &mut ProviderModel) -> Result<()> {
        model.id = model.id.trim().to_string();
        if !Self::valid_provider_model_id(&model.id) {
            return Err(Self::provider_model_error(
                EC::PROVIDER_MODEL_INVALID,
                "Provider model id is invalid",
            ));
        }

        model.label = model.label.take().and_then(|label| {
            let label = label.trim().to_string();
            (!label.is_empty()).then_some(label)
        });
        if model.label.as_ref().is_some_and(|label| {
            label.chars().count() > MAX_PROVIDER_MODEL_LABEL_CHARS
                || label.chars().any(|character| character.is_ascii_control())
        }) {
            return Err(Self::provider_model_error(
                EC::PROVIDER_MODEL_INVALID,
                "Provider model label is invalid",
            ));
        }
        model.default_effort = model.default_effort.take().and_then(|effort| {
            let effort = effort.trim().to_ascii_lowercase();
            (!effort.is_empty()).then_some(effort)
        });
        if model
            .default_effort
            .as_deref()
            .is_some_and(|effort| !PROVIDER_MODEL_EFFORTS.contains(&effort))
        {
            return Err(Self::provider_model_error(
                EC::PROVIDER_MODEL_INVALID,
                "Provider model defaultEffort is invalid",
            ));
        }
        if model.context_window_tokens.is_some_and(|window| {
            !(MIN_PROVIDER_CONTEXT_WINDOW_TOKENS..=MAX_PROVIDER_CONTEXT_WINDOW_TOKENS)
                .contains(&window)
        }) {
            return Err(Self::provider_model_error(
                EC::PROVIDER_MODEL_INVALID,
                format!(
                    "Provider model contextWindowTokens must be between {} and {}",
                    MIN_PROVIDER_CONTEXT_WINDOW_TOKENS, MAX_PROVIDER_CONTEXT_WINDOW_TOKENS
                ),
            ));
        }
        Ok(())
    }

    fn valid_provider_model_id(model_id: &str) -> bool {
        !model_id.is_empty()
            && model_id.chars().count() <= MAX_PROVIDER_MODEL_ID_CHARS
            && !model_id
                .chars()
                .any(|character| character.is_ascii_control())
    }

    fn provider_model_error(code: &str, message: impl Into<String>) -> anyhow::Error {
        anyhow::Error::new(AppError::coded(code, message))
    }

    /// 供应商自身字段的校验。账号 / 接口 / 环境变量在 `normalize_accounts` 里校验。
    fn validate_provider(provider: &Provider) -> Result<()> {
        let id = provider.id.trim();
        if id == SYSTEM_PROVIDER_ID {
            anyhow::bail!("Provider id '{}' is reserved", SYSTEM_PROVIDER_ID);
        }
        if id.is_empty()
            || id.chars().count() > MAX_PROVIDER_ID_CHARS
            || !id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
        {
            anyhow::bail!("Provider id is invalid");
        }
        let name = provider.name.trim();
        if name.is_empty() || name.chars().count() > MAX_PROVIDER_NAME_CHARS {
            anyhow::bail!("Provider name is invalid");
        }
        Self::validate_optional_length(provider.region.as_deref(), 512, "region")?;
        Self::validate_optional_length(provider.project_id.as_deref(), 512, "projectId")?;
        Self::validate_optional_length(provider.aws_profile.as_deref(), 512, "awsProfile")?;
        Ok(())
    }

    fn validate_optional_length(value: Option<&str>, max: usize, field: &str) -> Result<()> {
        if value.is_some_and(|value| value.chars().count() > max) {
            anyhow::bail!("Provider {field} is too long");
        }
        Ok(())
    }

    fn valid_env_key(key: &str) -> bool {
        let mut chars = key.chars();
        matches!(chars.next(), Some(character) if character.is_ascii_uppercase() || character == '_')
            && chars.all(|character| {
                character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_model(id: &str) -> ProviderModel {
        ProviderModel {
            id: id.to_string(),
            label: Some(format!("Label {id}")),
            default_effort: None,
            context_window_tokens: None,
            context_size: None,
            hidden: false,
        }
    }

    fn provider_model_error_code(error: &anyhow::Error) -> Option<&str> {
        error
            .downcast_ref::<crate::utils::error::AppError>()
            .and_then(crate::utils::error::AppError::code)
    }

    fn make_provider(id: &str, is_default: bool) -> Provider {
        Provider {
            id: id.to_string(),
            name: format!("Provider {}", id),
            provider_type: ProviderType::Anthropic,
            api_key: Some(format!("sk-{}", id)),
            base_url: Some("https://api.example.com".to_string()),
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: Vec::new(),
            default_model_id: None,
            codex_wire_api: None,
            is_default,
            ..Provider::default()
        }
    }

    fn make_config_profile_provider(id: &str, config_dir: Option<String>) -> Provider {
        Provider {
            id: id.to_string(),
            name: id.to_string(),
            provider_type: ProviderType::ConfigProfile,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir,
            models: Vec::new(),
            default_model_id: None,
            codex_wire_api: None,
            is_default: false,
            ..Provider::default()
        }
    }

    #[test]
    fn normalizes_provider_models_and_promotes_the_first_default() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-normalized", false);
        provider.models = vec![
            ProviderModel {
                id: "  model-a  ".to_string(),
                label: Some("  Model A  ".to_string()),
                default_effort: Some(" HIGH ".to_string()),
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
            provider_model("model-b"),
            ProviderModel {
                id: "model-c".to_string(),
                label: Some("   ".to_string()),
                default_effort: None,
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
        ];

        service.add_provider(provider).unwrap();
        let stored = service.get_provider("models-normalized").unwrap();

        assert_eq!(stored.models[0].id, "model-a");
        assert_eq!(stored.models[0].label.as_deref(), Some("Model A"));
        assert_eq!(stored.models[0].default_effort.as_deref(), Some("high"));
        assert_eq!(stored.models[2].label, None);
        assert_eq!(stored.default_model_id.as_deref(), Some("model-a"));
    }

    #[test]
    fn persists_context_window_tokens_and_validates_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);

        for (id, window) in [
            (
                "models-context-window-min",
                MIN_PROVIDER_CONTEXT_WINDOW_TOKENS,
            ),
            (
                "models-context-window-max",
                MAX_PROVIDER_CONTEXT_WINDOW_TOKENS,
            ),
        ] {
            let mut provider = make_provider(id, false);
            provider.models = vec![ProviderModel {
                id: "model-a".to_string(),
                label: Some("Model A".to_string()),
                default_effort: None,
                context_window_tokens: Some(window),
                context_size: None,
                hidden: false,
            }];

            service.add_provider(provider).unwrap();
            assert_eq!(
                service.get_provider(id).unwrap().models[0].context_window_tokens,
                Some(window)
            );
        }

        let persisted_id = "models-context-window-invalid-update";
        let mut persisted = make_provider(persisted_id, false);
        persisted.models = vec![ProviderModel {
            id: "model-a".to_string(),
            label: None,
            default_effort: None,
            context_window_tokens: Some(128_000),
            context_size: None,
            hidden: false,
        }];
        service.add_provider(persisted).unwrap();

        for invalid_window in [
            MIN_PROVIDER_CONTEXT_WINDOW_TOKENS - 1,
            MAX_PROVIDER_CONTEXT_WINDOW_TOKENS + 1,
        ] {
            let mut invalid = service.get_provider(persisted_id).unwrap();
            invalid.models[0].context_window_tokens = Some(invalid_window);
            let error = service.update_provider(invalid).unwrap_err();
            assert_eq!(
                provider_model_error_code(&error),
                Some("PROVIDER_MODEL_INVALID")
            );
            assert_eq!(
                service.get_provider(persisted_id).unwrap().models[0].context_window_tokens,
                Some(128_000)
            );
        }

        let reloaded = new_service(&dir);
        assert_eq!(
            reloaded.get_provider(persisted_id).unwrap().models[0].context_window_tokens,
            Some(128_000)
        );
    }

    #[test]
    fn accepts_provider_model_id_and_label_at_exact_limits() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-at-limits", false);
        provider.models = vec![ProviderModel {
            id: "i".repeat(MAX_PROVIDER_MODEL_ID_CHARS),
            label: Some("l".repeat(MAX_PROVIDER_MODEL_LABEL_CHARS)),
            default_effort: None,
            context_window_tokens: None,
            context_size: None,
            hidden: false,
        }];

        service.add_provider(provider).unwrap();
        let stored = service.get_provider("models-at-limits").unwrap();

        assert_eq!(
            stored.models[0].id.chars().count(),
            MAX_PROVIDER_MODEL_ID_CHARS
        );
        assert_eq!(
            stored.models[0].label.as_deref().unwrap().chars().count(),
            MAX_PROVIDER_MODEL_LABEL_CHARS
        );
    }

    #[test]
    fn rejects_duplicate_provider_model_ids_after_trimming() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-duplicate", false);
        provider.models = vec![provider_model("same-model"), provider_model(" same-model ")];

        let error = service.add_provider(provider).unwrap_err().to_string();

        assert!(error.contains("Duplicate Provider model id"));
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn duplicate_provider_model_ids_return_a_coded_error() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-duplicate-code", false);
        provider.models = vec![provider_model("same-model"), provider_model(" same-model ")];

        let error = service.add_provider(provider).unwrap_err();

        assert_eq!(
            provider_model_error_code(&error),
            Some("PROVIDER_MODEL_DUPLICATE")
        );
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn rejects_provider_default_model_missing_from_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-default-missing", false);
        provider.models = vec![provider_model("model-a")];
        provider.default_model_id = Some("model-missing".to_string());

        let error = service.add_provider(provider).unwrap_err().to_string();

        assert!(error.contains("defaultModelId"));
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn rejects_provider_model_catalog_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-over-limit", false);
        provider.models = (0..=100)
            .map(|index| provider_model(&format!("model-{index}")))
            .collect();

        let error = service.add_provider(provider).unwrap_err().to_string();

        assert!(error.contains("100"));
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn accepts_provider_model_catalog_at_exact_limit() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-at-count-limit", false);
        provider.models = (0..MAX_PROVIDER_MODELS)
            .map(|index| provider_model(&format!("model-{index}")))
            .collect();

        service.add_provider(provider).unwrap();

        assert_eq!(
            service
                .get_provider("models-at-count-limit")
                .unwrap()
                .models
                .len(),
            MAX_PROVIDER_MODELS
        );
    }

    #[test]
    fn rejects_provider_model_ids_with_control_characters() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-control-character", false);
        provider.models = vec![provider_model("model-a\n--dangerous")];

        let error = service.add_provider(provider).unwrap_err();

        assert_eq!(
            provider_model_error_code(&error),
            Some("PROVIDER_MODEL_INVALID")
        );
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn rejects_blank_or_oversized_provider_model_fields_with_coded_errors() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);

        let invalid_models = [
            ProviderModel {
                id: "   ".to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
            ProviderModel {
                id: "i".repeat(MAX_PROVIDER_MODEL_ID_CHARS + 1),
                label: None,
                default_effort: None,
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
            ProviderModel {
                id: "valid-id".to_string(),
                label: Some("l".repeat(MAX_PROVIDER_MODEL_LABEL_CHARS + 1)),
                default_effort: None,
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
        ];

        for (index, model) in invalid_models.into_iter().enumerate() {
            let mut provider = make_provider(&format!("models-invalid-{index}"), false);
            provider.models = vec![model];
            let error = service.add_provider(provider).unwrap_err();

            assert_eq!(
                provider_model_error_code(&error),
                Some("PROVIDER_MODEL_INVALID")
            );
        }
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn rejects_unknown_provider_model_default_effort() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-invalid-effort", false);
        let mut model = provider_model("model-a");
        model.default_effort = Some("turbo".to_string());
        provider.models = vec![model];

        let error = service.add_provider(provider).unwrap_err();

        assert_eq!(
            provider_model_error_code(&error),
            Some("PROVIDER_MODEL_INVALID")
        );
        assert!(error.to_string().contains("defaultEffort"));
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn rejects_invalid_default_model_ids_with_a_coded_error() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let invalid_defaults = [
            "model-a\n--dangerous".to_string(),
            "i".repeat(MAX_PROVIDER_MODEL_ID_CHARS + 1),
        ];

        for (index, default_model_id) in invalid_defaults.into_iter().enumerate() {
            let mut provider = make_provider(&format!("models-default-invalid-{index}"), false);
            provider.models = vec![provider_model("model-a")];
            provider.default_model_id = Some(default_model_id);
            let error = service.add_provider(provider).unwrap_err();

            assert_eq!(
                provider_model_error_code(&error),
                Some("PROVIDER_MODEL_INVALID")
            );
            assert!(!error.to_string().contains("--dangerous"));
        }
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn empty_provider_model_catalog_clears_a_blank_default() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-empty", false);
        provider.default_model_id = Some("   ".to_string());

        service.add_provider(provider).unwrap();

        assert_eq!(
            service
                .get_provider("models-empty")
                .unwrap()
                .default_model_id,
            None
        );
    }

    #[test]
    fn updating_after_removing_the_default_model_promotes_the_first_remaining_model() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("models-remove-default", false);
        provider.models = vec![provider_model("model-a"), provider_model("model-b")];
        provider.default_model_id = Some("model-b".to_string());
        service.add_provider(provider).unwrap();

        let mut updated = service.get_provider("models-remove-default").unwrap();
        updated.models.retain(|model| model.id != "model-b");
        updated.default_model_id = None;
        service.update_provider(updated).unwrap();

        let stored = service.get_provider("models-remove-default").unwrap();
        assert_eq!(stored.default_model_id.as_deref(), Some("model-a"));
    }

    #[test]
    fn oversized_provider_config_save_does_not_change_memory_or_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let service = ProviderService::new(path.clone());
        for index in 0..15 {
            let mut provider = make_provider(&format!("large-{index}"), false);
            provider.api_key = Some("x".repeat(MAX_PROVIDER_SECRET_CHARS));
            service.add_provider(provider).unwrap();
        }
        let count_before = service.list_providers().len();
        let disk_before = std::fs::read(&path).unwrap();
        let mut provider = make_provider("large-over-limit", false);
        provider.api_key = Some("x".repeat(MAX_PROVIDER_SECRET_CHARS));

        let error = service.add_provider(provider).unwrap_err();

        assert!(error.to_string().contains("exceeds"));
        assert_eq!(service.list_providers().len(), count_before);
        assert_eq!(std::fs::read(&path).unwrap(), disk_before);
        assert_eq!(
            ProviderService::new(path).list_providers().len(),
            count_before
        );
    }

    #[test]
    fn separate_service_instances_observe_provider_file_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let daemon_service = ProviderService::new(path.clone());
        let desktop_service = ProviderService::new(path);

        desktop_service
            .add_provider(make_provider("fresh-provider", true))
            .unwrap();

        let observed = daemon_service.get_provider("fresh-provider").unwrap();
        assert_eq!(observed.name, "Provider fresh-provider");
        assert_eq!(
            daemon_service
                .get_env_vars(Some("fresh-provider"))
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-fresh-provider")
        );
    }

    #[test]
    fn separate_service_instances_preserve_updates_across_write_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let writer_a = ProviderService::new(path.clone());
        let writer_b = ProviderService::new(path.clone());

        writer_a.add_provider(make_provider("a", false)).unwrap();
        writer_b.add_provider(make_provider("b", false)).unwrap();
        writer_a
            .add_provider_unique(make_provider("c", false))
            .unwrap();

        let mut updated_c = make_provider("c", false);
        updated_c.name = "updated-c".to_string();
        writer_b.update_provider(updated_c).unwrap();
        writer_a.set_default("c").unwrap();
        writer_b.set_default_for_cli("codex", "c").unwrap();
        writer_a.remove_provider("a").unwrap();

        let reloaded = ProviderService::new(path);
        assert_eq!(
            reloaded
                .list_providers()
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert_eq!(reloaded.get_provider("c").unwrap().name, "updated-c");
        assert_eq!(
            reloaded.get_default_provider_id("claude").as_deref(),
            Some("c")
        );
        assert_eq!(
            reloaded.get_default_provider_id("codex").as_deref(),
            Some("c")
        );
    }

    fn new_service(dir: &tempfile::TempDir) -> ProviderService {
        ProviderService::new(dir.path().join("providers.json"))
    }

    fn write_cc_switch_db(path: &std::path::Path, rows: &[(&str, &str, &str, serde_json::Value)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            "CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            )",
            [],
        )
        .unwrap();
        for (id, app_type, name, settings) in rows {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, app_type, name, settings.to_string()],
            )
            .unwrap();
        }
    }

    #[test]
    fn import_cc_switch_copies_new_rows_and_skips_duplicates_without_changing_default() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_provider("existing", true))
            .unwrap();
        let db_path = dir.path().join("cc-switch.db");
        write_cc_switch_db(
            &db_path,
            &[
                (
                    "p1",
                    "claude",
                    "Provider existing",
                    serde_json::json!({"env":{"ANTHROPIC_API_KEY":"sk-existing","ANTHROPIC_BASE_URL":"https://api.example.com"}}),
                ),
                (
                    "p2",
                    "claude",
                    "Imported Relay",
                    serde_json::json!({"env":{"ANTHROPIC_AUTH_TOKEN":"sk-new","ANTHROPIC_BASE_URL":"https://relay.example"}}),
                ),
                (
                    "p3",
                    "openclaw",
                    "Nope",
                    serde_json::json!({"env":{"FOO":"1"}}),
                ),
            ],
        );

        let report = service.import_cc_switch_providers(Some(&db_path)).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped_duplicate, 1);
        assert_eq!(report.skipped_unsupported, 1);

        let names: Vec<_> = service
            .list_providers()
            .into_iter()
            .map(|provider| provider.name)
            .collect();
        assert!(names.contains(&"Imported Relay".to_string()));
        assert_eq!(
            service.get_default_provider_id("claude").as_deref(),
            Some("existing")
        );
        let imported = service
            .list_providers()
            .into_iter()
            .find(|provider| provider.name == "Imported Relay")
            .unwrap();
        // 抄来的密钥落在默认账号上（不再挂在 Provider 上），照常解析成环境变量。
        assert_eq!(imported.api_key, None);
        assert_eq!(
            service
                .get_env_vars(Some(&imported.id))
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-new")
        );
        assert!(!imported.is_default);
    }

    #[test]
    fn external_magpie_preview_marks_duplicates_and_import_takes_only_selected_keys() {
        use crate::services::external_provider_import::ExternalProviderSource;
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        // 与 CC-Panes 自己的 providers.json 同名：放进子目录，免得被服务写回覆盖
        let magpie_dir = dir.path().join("magpie");
        std::fs::create_dir_all(&magpie_dir).unwrap();
        let path = magpie_dir.join("providers.json");
        std::fs::write(
            &path,
            r#"{"providers":[
                {"id":"relay","name":"Relay","key":"sk-r","anthropic":"https://relay.example","responses":"https://relay.example/v1"},
                {"id":"gem","name":"Gem","key":"sk-g","gemini":"https://gem.example"}
            ]}"#,
        )
        .unwrap();

        let preview = service
            .preview_external_providers(ExternalProviderSource::Magpie, Some(&path))
            .unwrap();
        assert!(preview.available);
        assert_eq!(preview.candidates.len(), 3);
        assert!(preview.candidates.iter().all(|c| !c.duplicate && c.has_key));

        let claude_key = preview
            .candidates
            .iter()
            .find(|c| c.name == "Relay (Claude)")
            .unwrap()
            .key
            .clone();
        let report = service
            .import_external_providers(
                ExternalProviderSource::Magpie,
                Some(&[claude_key.clone()]),
                Some(&path),
            )
            .unwrap();
        assert_eq!(report.imported, 1);
        let imported = service
            .list_providers()
            .into_iter()
            .find(|p| p.name == "Relay (Claude)")
            .unwrap();
        assert_eq!(
            service
                .get_env_vars(Some(&imported.id))
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-r")
        );

        let again = service
            .preview_external_providers(ExternalProviderSource::Magpie, Some(&path))
            .unwrap();
        let claude = again
            .candidates
            .iter()
            .find(|c| c.key == claude_key)
            .unwrap();
        assert!(claude.duplicate);
        assert_eq!(again.candidates.iter().filter(|c| c.duplicate).count(), 1);

        let report = service
            .import_external_providers(ExternalProviderSource::Magpie, None, Some(&path))
            .unwrap();
        assert_eq!(report.imported, 2);
        assert_eq!(report.skipped_duplicate, 1);
    }

    #[test]
    fn external_preview_missing_source_is_unavailable_not_an_error() {
        use crate::services::external_provider_import::ExternalProviderSource;
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let preview = service
            .preview_external_providers(
                ExternalProviderSource::Magpie,
                Some(&dir.path().join("missing.json")),
            )
            .unwrap();
        assert!(!preview.available);
        assert!(preview.candidates.is_empty());
    }

    #[test]
    fn import_cc_switch_missing_db_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let error = service
            .import_cc_switch_providers(Some(&dir.path().join("missing.db")))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not found"));
    }

    #[test]
    fn import_cc_switch_duplicates_at_capacity_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut current = service.lock_latest_config();
        let mut next = current.clone();
        // 直接写内部配置，绕过了 add_provider：手动归一成账号结构（与正常入库一致）。
        next.providers = (0..MAX_PROVIDER_COUNT)
            .map(|i| {
                ProviderService::normalize_legacy_provider(make_provider(
                    &format!("existing-{i}"),
                    false,
                ))
                .unwrap()
            })
            .collect();
        service.commit_config(&mut current, next).unwrap();
        drop(current);
        let before = std::fs::read(dir.path().join("providers.json")).unwrap();
        let source = dir.path().join("cc-switch.db");
        write_cc_switch_db(
            &source,
            &[(
                "one",
                "claude",
                "Provider existing-0",
                serde_json::json!({"env":{"ANTHROPIC_API_KEY":"different-key","ANTHROPIC_BASE_URL":"https://api.example.com"}}),
            )],
        );
        let report = service.import_cc_switch_providers(Some(&source)).unwrap();
        assert_eq!(report.imported, 0);
        assert_eq!(report.skipped_duplicate, 1);
        assert_eq!(
            std::fs::read(dir.path().join("providers.json")).unwrap(),
            before
        );
    }

    #[test]
    fn import_cc_switch_invalid_later_row_does_not_commit_partial_changes() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_provider("existing", true))
            .unwrap();
        let before = std::fs::read(dir.path().join("providers.json")).unwrap();
        let source = dir.path().join("cc-switch.db");
        write_cc_switch_db(
            &source,
            &[
                (
                    "valid",
                    "claude",
                    "Valid",
                    serde_json::json!({"env":{"ANTHROPIC_API_KEY":"test-key"}}),
                ),
                (
                    "invalid",
                    "claude",
                    "Invalid",
                    serde_json::json!({"env":{"ANTHROPIC_BASE_URL":"file:///invalid"}}),
                ),
            ],
        );
        let source_before = std::fs::read(&source).unwrap();
        assert!(service.import_cc_switch_providers(Some(&source)).is_err());
        assert_eq!(service.list_providers().len(), 1);
        assert_eq!(
            std::fs::read(dir.path().join("providers.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read(&source).unwrap(), source_before);
    }

    #[test]
    fn missing_config_file_yields_empty_providers() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        assert!(service.list_providers().is_empty());
        assert!(service.get_default_provider().is_none());
        assert!(service.get_provider("nope").is_none());
    }

    #[test]
    fn corrupt_config_file_falls_back_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        std::fs::write(&path, "{ not json").unwrap();
        let service = ProviderService::new(path);
        assert!(service.list_providers().is_empty());
    }

    #[test]
    fn load_from_file_filters_out_legacy_media_providers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        // 模拟老数据：一个 provider_type="media" 的条目 + 一个正常条目
        let json = serde_json::json!({
            "providers": [
                {
                    "id": "media-provider",
                    "name": "Old Media Provider",
                    "providerType": "media",
                    "apiKey": "sk-old",
                    "baseUrl": "https://image-api.example.com"
                },
                {
                    "id": "normal-provider",
                    "name": "Anthropic Provider",
                    "providerType": "anthropic",
                    "apiKey": "sk-anthropic",
                    "baseUrl": "https://api.anthropic.com"
                }
            ],
            "defaultProviderIds": {},
            "defaultProviderIdsVersion": 2,
            "defaultIsSystem": false
        });
        std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        let service = ProviderService::new(path);

        // media 条目被丢弃
        assert_eq!(service.list_providers().len(), 1);
        assert!(service.get_provider("media-provider").is_none());
        // 正常条目保留
        let normal = service.get_provider("normal-provider").unwrap();
        assert_eq!(normal.name, "Anthropic Provider");
        assert_eq!(normal.provider_type, ProviderType::Anthropic);
    }

    #[test]
    fn first_added_provider_becomes_default_only_for_its_native_cli() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);

        service.add_provider(make_provider("a", false)).unwrap();

        let providers = service.list_providers();
        assert_eq!(providers.len(), 1);
        assert!(providers[0].is_default);
        assert_eq!(service.get_default_provider().unwrap().id, "a");
        assert_eq!(
            service.get_default_provider_id("claude").as_deref(),
            Some("a")
        );
        assert_eq!(service.get_default_provider_id("opencode"), None);
        assert_eq!(service.get_default_provider_id("codex"), None);
    }

    #[test]
    fn legacy_fanned_out_defaults_are_reduced_to_native_cli_mappings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let mut anthropic = make_provider("anthropic-provider", true);
        anthropic.provider_type = ProviderType::Anthropic;
        let mut open_ai = make_provider("openai-provider", true);
        open_ai.provider_type = ProviderType::OpenAI;
        let mut default_provider_ids = PROVIDER_CLI_TOOLS
            .into_iter()
            .map(|cli_tool| (cli_tool.to_string(), anthropic.id.clone()))
            .collect::<HashMap<_, _>>();
        default_provider_ids.insert("codex".to_string(), open_ai.id.clone());
        let config = ProviderConfig {
            schema_version: 0,
            providers: vec![anthropic, open_ai],
            default_provider_ids,
            default_provider_ids_version: 0,
            default_is_system: false,
        };
        std::fs::write(&path, serde_json::to_string(&config).unwrap()).unwrap();

        let service = ProviderService::new(path);

        assert_eq!(
            service.get_default_provider_id("claude").as_deref(),
            Some("anthropic-provider")
        );
        assert_eq!(
            service.get_default_provider_id("codex").as_deref(),
            Some("openai-provider")
        );
        assert_eq!(service.get_default_provider_id("opencode"), None);
        assert_eq!(service.system_provider_info().default_provider_ids.len(), 2);
    }

    #[test]
    fn adding_default_provider_clears_other_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", true)).unwrap();

        let providers = service.list_providers();
        let a = providers.iter().find(|p| p.id == "a").unwrap();
        let b = providers.iter().find(|p| p.id == "b").unwrap();
        assert!(!a.is_default);
        assert!(b.is_default);
    }

    #[test]
    fn add_persists_to_file_for_new_instance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        {
            let service = ProviderService::new(path.clone());
            service.add_provider(make_provider("a", false)).unwrap();
        }
        let reloaded = ProviderService::new(path);
        assert_eq!(reloaded.list_providers().len(), 1);
        assert_eq!(reloaded.get_provider("a").unwrap().id, "a");
    }

    #[test]
    fn update_provider_not_found_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        assert!(service
            .update_provider(make_provider("ghost", false))
            .is_err());
    }

    #[test]
    fn update_provider_replaces_and_handles_default_flag() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", false)).unwrap();
        // a 目前是默认（第一个自动设默认）
        assert_eq!(service.get_default_provider().unwrap().id, "a");

        let mut updated_b = make_provider("b", true);
        updated_b.name = "renamed".to_string();
        service.update_provider(updated_b).unwrap();

        let b = service.get_provider("b").unwrap();
        assert_eq!(b.name, "renamed");
        assert!(b.is_default);
        assert!(!service.get_provider("a").unwrap().is_default);
    }

    #[test]
    fn update_provider_keeps_import_source_when_payload_omits_it() {
        use crate::models::provider::{ProviderOrigin, ProviderOriginKind};
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let origin = ProviderOrigin {
            kind: ProviderOriginKind::CcSwitch,
            external_id: Some("ext-1".to_string()),
            imported_at: Some("2026-01-01T00:00:00Z".to_string()),
            fingerprint: Some("fp".to_string()),
        };
        let mut imported = make_provider("a", false);
        imported.source = Some(origin.clone());
        service.add_provider(imported).unwrap();

        let mut edited = make_provider("a", false);
        edited.name = "renamed".to_string();
        edited.source = None;
        service.update_provider(edited).unwrap();

        let stored = service.get_provider("a").unwrap();
        assert_eq!(stored.name, "renamed");
        assert_eq!(stored.source, Some(origin));
    }

    #[test]
    fn provider_alerts_default_on_and_survive_updates_without_them() {
        use crate::models::provider::ProviderAlerts;
        let parsed: ProviderAlerts = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, ProviderAlerts::default());
        assert!(parsed.cache_low && parsed.injection);

        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut a = make_provider("a", false);
        a.alerts = Some(ProviderAlerts {
            cache_low: false,
            injection: true,
        });
        service.add_provider(a).unwrap();

        // 不带提醒开关的保存沿用已存的选择
        let mut renamed = make_provider("a", false);
        renamed.name = "renamed".to_string();
        service.update_provider(renamed).unwrap();
        let alerts = service.get_provider("a").unwrap().alerts.unwrap();
        assert!(!alerts.cache_low && alerts.injection);
    }

    #[test]
    fn remove_default_provider_returns_cli_to_native_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", false)).unwrap();

        service.remove_provider("a").unwrap();

        let providers = service.list_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
        assert!(!providers[0].is_default);
        assert_eq!(service.get_default_provider_id("claude"), None);
    }

    #[test]
    fn remove_non_default_keeps_default_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", false)).unwrap();

        service.remove_provider("b").unwrap();

        assert_eq!(service.get_default_provider().unwrap().id, "a");
    }

    #[test]
    fn remove_unknown_provider_is_noop_ok() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.remove_provider("ghost").unwrap();
        assert_eq!(service.list_providers().len(), 1);
    }

    #[test]
    fn set_default_switches_exclusively() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", false)).unwrap();

        service.set_default("b").unwrap();

        assert!(!service.get_provider("a").unwrap().is_default);
        assert!(service.get_provider("b").unwrap().is_default);
    }

    #[test]
    fn real_provider_default_persists_across_service_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        {
            let service = ProviderService::new(path.clone());
            service.add_provider(make_provider("a", false)).unwrap();
            service.add_provider(make_provider("b", false)).unwrap();
            service.set_default("b").unwrap();
        }

        let reloaded = ProviderService::new(path);

        assert_eq!(reloaded.get_default_provider().unwrap().id, "b");
        assert!(reloaded.get_provider("b").unwrap().is_default);
        assert!(!reloaded.system_provider_info().default_is_system);
    }

    #[test]
    fn cli_defaults_are_independent_and_persist_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        {
            let service = ProviderService::new(path.clone());
            service
                .add_provider(make_provider("claude-provider", false))
                .unwrap();
            service
                .add_provider(make_provider("codex-provider", false))
                .unwrap();
            service
                .set_default_for_cli("claude", "claude-provider")
                .unwrap();
            service
                .set_default_for_cli("codex", "codex-provider")
                .unwrap();
        }

        let reloaded = ProviderService::new(path);
        assert_eq!(
            reloaded.get_default_provider_id("claude").as_deref(),
            Some("claude-provider")
        );
        assert_eq!(
            reloaded.get_default_provider_id("codex").as_deref(),
            Some("codex-provider")
        );
        assert_eq!(
            reloaded.get_default_provider_for_cli("claude").unwrap().id,
            "claude-provider"
        );
        assert_eq!(
            reloaded.get_default_provider_for_cli("codex").unwrap().id,
            "codex-provider"
        );
    }

    #[test]
    fn system_default_is_scoped_to_one_cli() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_provider("managed", false))
            .unwrap();
        service
            .set_default_for_cli("claude", SYSTEM_PROVIDER_ID)
            .unwrap();
        service.set_default_for_cli("codex", "managed").unwrap();

        let info = service.system_provider_info();
        assert_eq!(
            info.default_provider_ids.get("claude").map(String::as_str),
            Some(SYSTEM_PROVIDER_ID)
        );
        assert_eq!(
            info.default_provider_ids.get("codex").map(String::as_str),
            Some("managed")
        );
    }

    #[test]
    fn get_default_provider_falls_back_to_first_when_none_marked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        // 手写配置：两个 provider 都没有 default 标记
        let config = ProviderConfig {
            schema_version: 0,
            providers: vec![make_provider("a", false), make_provider("b", false)],
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_string(&config).unwrap()).unwrap();

        let service = ProviderService::new(path);
        assert_eq!(service.get_default_provider().unwrap().id, "a");
    }

    #[test]
    fn set_default_system_clears_provider_defaults_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        {
            let service = ProviderService::new(path.clone());
            service.add_provider(make_provider("a", false)).unwrap();
            assert!(service.get_provider("a").unwrap().is_default);

            service
                .set_default(crate::models::provider::SYSTEM_PROVIDER_ID)
                .unwrap();

            assert!(!service.get_provider("a").unwrap().is_default);
            assert!(service.system_provider_info().default_is_system);
            // 保留 id 仍不得落入 providers 列表
            assert!(service
                .get_provider(crate::models::provider::SYSTEM_PROVIDER_ID)
                .is_none());
        }
        // 重启（新实例读盘）后仍生效
        let reloaded = ProviderService::new(path);
        assert!(reloaded.system_provider_info().default_is_system);
        assert!(!reloaded.get_provider("a").unwrap().is_default);
    }

    #[test]
    fn set_default_real_provider_resets_system_flag() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service
            .set_default(crate::models::provider::SYSTEM_PROVIDER_ID)
            .unwrap();
        assert!(service.system_provider_info().default_is_system);

        service.set_default("a").unwrap();

        assert!(!service.system_provider_info().default_is_system);
        assert!(service.get_provider("a").unwrap().is_default);
    }

    #[test]
    fn adding_first_provider_does_not_steal_system_default() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .set_default(crate::models::provider::SYSTEM_PROVIDER_ID)
            .unwrap();

        service.add_provider(make_provider("a", false)).unwrap();

        assert!(!service.get_provider("a").unwrap().is_default);
        assert!(service.system_provider_info().default_is_system);
    }

    #[test]
    fn marking_a_provider_default_via_add_or_update_resets_system_flag() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .set_default(crate::models::provider::SYSTEM_PROVIDER_ID)
            .unwrap();

        service.add_provider(make_provider("a", true)).unwrap();
        assert!(!service.system_provider_info().default_is_system);

        service
            .set_default(crate::models::provider::SYSTEM_PROVIDER_ID)
            .unwrap();
        service.update_provider(make_provider("a", true)).unwrap();
        assert!(!service.system_provider_info().default_is_system);
    }

    #[test]
    fn system_provider_info_reports_hit_env_keys_without_values() {
        // 刻意避开 system_provider_active_true_when_anthropic_env_set 用的 AUTH_TOKEN：
        // 进程级 env 是全局共享的，两个用例并行改同一个 key 会互相打架。
        const KEY: &str = "ANTHROPIC_BASE_URL";
        const VALUE: &str = "https://secret.example.com";
        let saved = std::env::var(KEY).ok();
        std::env::set_var(KEY, VALUE);

        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let info = service.system_provider_info();

        match saved {
            Some(v) => std::env::set_var(KEY, v),
            None => std::env::remove_var(KEY),
        }

        assert!(info.active);
        assert!(info.env_keys.contains(&KEY.to_string()));
        // 只回传键名，值绝不外泄
        assert!(!info.env_keys.iter().any(|k| k.contains(VALUE)));
    }

    #[test]
    fn get_env_vars_none_id_injects_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", true)).unwrap();
        assert!(service.get_env_vars(None).is_empty());
    }

    #[test]
    fn get_env_vars_unknown_id_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", true)).unwrap();
        assert!(service.get_env_vars(Some("ghost")).is_empty());
    }

    #[test]
    fn get_env_vars_system_sentinel_injects_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        // 即便存了个默认 provider，选「系统」也不注入。
        service.add_provider(make_provider("a", true)).unwrap();
        assert!(service
            .get_env_vars(Some(crate::models::provider::SYSTEM_PROVIDER_ID))
            .is_empty());
    }

    #[test]
    fn add_and_update_reject_reserved_system_id() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut sys = make_provider(crate::models::provider::SYSTEM_PROVIDER_ID, false);
        sys.name = "spoof".to_string();
        assert!(service.add_provider(sys.clone()).is_err());
        assert!(service.update_provider(sys).is_err());
        // 保留 id 不得进入持久化列表
        assert!(service
            .get_provider(crate::models::provider::SYSTEM_PROVIDER_ID)
            .is_none());
    }

    #[test]
    fn system_provider_active_true_when_anthropic_env_set() {
        // 该用例改写进程级 env，用一个平时不存在的专用 key，测完恢复原值，
        // 避免污染其它用例或本机真实的 ANTHROPIC_API_KEY。
        const KEY: &str = "ANTHROPIC_AUTH_TOKEN";
        let saved = std::env::var(KEY).ok();
        std::env::set_var(KEY, "sk-test");
        let active = ProviderService::system_provider_active();
        match saved {
            Some(v) => std::env::set_var(KEY, v),
            None => std::env::remove_var(KEY),
        }
        assert!(active);
    }

    #[test]
    fn get_env_vars_anthropic_provider_maps_key_and_base_url() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", true)).unwrap();

        let vars = service.get_env_vars(Some("a"));
        assert_eq!(vars.get("ANTHROPIC_API_KEY"), Some(&"sk-a".to_string()));
        assert_eq!(
            vars.get("ANTHROPIC_BASE_URL"),
            Some(&"https://api.example.com".to_string())
        );
    }

    #[test]
    fn config_profile_directory_mode_sets_claude_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let profile_dir = dir.path().join("profile");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_config_profile_provider(
                "p",
                Some(profile_dir.to_string_lossy().to_string()),
            ))
            .unwrap();

        let vars = service.get_env_vars(Some("p"));
        assert_eq!(
            vars.get("CLAUDE_CONFIG_DIR"),
            Some(&profile_dir.to_string_lossy().to_string())
        );
    }

    #[test]
    fn config_profile_file_mode_parses_env_field() {
        let dir = tempfile::tempdir().unwrap();
        let config_file = dir.path().join("profile.json");
        std::fs::write(
            &config_file,
            r#"{"env": {"ANTHROPIC_API_KEY": "sk-from-file", "IGNORED_NUM": 42}}"#,
        )
        .unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_config_profile_provider(
                "p",
                Some(config_file.to_string_lossy().to_string()),
            ))
            .unwrap();

        let vars = service.get_env_vars(Some("p"));
        assert_eq!(
            vars.get("ANTHROPIC_API_KEY"),
            Some(&"sk-from-file".to_string())
        );
        // 非字符串值被跳过
        assert!(!vars.contains_key("IGNORED_NUM"));
    }

    #[test]
    fn config_profile_file_without_env_field_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let config_file = dir.path().join("profile.json");
        std::fs::write(&config_file, r#"{"other": true}"#).unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_config_profile_provider(
                "p",
                Some(config_file.to_string_lossy().to_string()),
            ))
            .unwrap();

        assert!(service.get_env_vars(Some("p")).is_empty());
    }

    #[test]
    fn config_profile_invalid_json_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let config_file = dir.path().join("profile.json");
        std::fs::write(&config_file, "not json at all").unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_config_profile_provider(
                "p",
                Some(config_file.to_string_lossy().to_string()),
            ))
            .unwrap();

        assert!(service.get_env_vars(Some("p")).is_empty());
    }

    #[test]
    fn config_profile_missing_path_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_config_profile_provider(
                "p",
                Some(dir.path().join("nope").to_string_lossy().to_string()),
            ))
            .unwrap();
        assert!(service.get_env_vars(Some("p")).is_empty());

        let service2 = new_service(&dir);
        service2
            .add_provider(make_config_profile_provider("q", None))
            .unwrap();
        assert!(service2.get_env_vars(Some("q")).is_empty());
    }

    #[test]
    fn rejects_duplicate_or_invalid_provider_ids_without_overwriting_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service
            .add_provider(make_provider("stable-id", false))
            .unwrap();

        assert!(service
            .add_provider(make_provider("stable-id", false))
            .is_err());
        assert!(service
            .add_provider(make_provider("../escape", false))
            .is_err());
        assert_eq!(service.list_providers().len(), 1);
    }

    #[test]
    fn rejects_oversized_provider_fields() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        let mut provider = make_provider("large-secret", false);
        provider.api_key = Some("x".repeat(MAX_PROVIDER_SECRET_CHARS + 1));

        let error = service.add_provider(provider).unwrap_err().to_string();
        assert!(error.contains("apiKey"));
        assert!(!error.contains(&"x".repeat(100)));
    }

    #[test]
    fn config_profile_filters_invalid_env_keys_and_rejects_too_many_items() {
        let dir = tempfile::tempdir().unwrap();
        let config_file = dir.path().join("profile.json");
        std::fs::write(
            &config_file,
            r#"{"env":{"GOOD_KEY":"value","bad-key":"secret","2BAD":"secret"}}"#,
        )
        .unwrap();
        let vars = ProviderService::parse_env_config_file(&config_file).unwrap();
        assert_eq!(vars.get("GOOD_KEY").map(String::as_str), Some("value"));
        assert!(!vars.contains_key("bad-key"));
        assert!(!vars.contains_key("2BAD"));

        let env = (0..=MAX_CONFIG_ENV_ITEMS)
            .map(|index| (format!("KEY_{index}"), serde_json::json!("value")))
            .collect::<serde_json::Map<_, _>>();
        std::fs::write(&config_file, serde_json::json!({ "env": env }).to_string()).unwrap();
        assert!(ProviderService::parse_env_config_file(&config_file).is_err());
    }
}
