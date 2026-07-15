use crate::models::provider::{Provider, ProviderConfig, ProviderType, SYSTEM_PROVIDER_ID};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tracing::warn;

/// Provider 服务 - 管理 AI Provider 配置
pub struct ProviderService {
    config_path: PathBuf,
    config: Mutex<ProviderConfig>,
}

impl ProviderService {
    pub fn new(config_path: PathBuf) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();

        Self {
            config_path,
            config: Mutex::new(config),
        }
    }

    fn load_from_file(path: &Path) -> Result<ProviderConfig> {
        let content =
            std::fs::read_to_string(path).with_context(|| "Failed to read providers config")?;
        let config: ProviderConfig =
            serde_json::from_str(&content).with_context(|| "Failed to parse providers.json")?;
        Ok(config)
    }

    fn save_to_file(&self, config: &ProviderConfig) -> Result<()> {
        let content = serde_json::to_string_pretty(config)
            .with_context(|| "Failed to serialize providers config")?;
        // providers.json 存有全部供应商配置（含明文 API key）。原子写（temp+fsync+rename，
        // 内部会建父目录）杜绝崩溃/断电写到一半导致截断丢失。
        crate::utils::atomic_file::write_atomic(&self.config_path, content)
            .with_context(|| "Failed to write providers config")?;
        Ok(())
    }

    /// 列出所有 Provider
    pub fn list_providers(&self) -> Vec<Provider> {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .providers
            .clone()
    }

    /// 获取指定 Provider
    pub fn get_provider(&self, id: &str) -> Option<Provider> {
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
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        config
            .providers
            .iter()
            .find(|p| p.is_default)
            .or_else(|| config.providers.first())
            .cloned()
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
        let ccswitch_db = dirs::home_dir().map(|h| h.join(".cc-switch").join("cc-switch.db"));
        if ccswitch_db.map(|p| p.is_file()).unwrap_or(false) {
            return true;
        }

        [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
        ]
        .iter()
        .any(|key| std::env::var(key).map(|v| !v.is_empty()).unwrap_or(false))
    }

    /// 添加 Provider
    pub fn add_provider(&self, mut provider: Provider) -> Result<()> {
        // `__system__` 是合成「系统环境变量」条目的保留 id，禁止落盘，
        // 否则会与列表顶部的虚拟条目撞 id、且凭证永远被 get_env_vars 短路忽略。
        if provider.id == SYSTEM_PROVIDER_ID {
            anyhow::bail!("Provider id '{}' is reserved", SYSTEM_PROVIDER_ID);
        }

        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        // 如果是默认 Provider，取消其他的默认状态
        if provider.is_default {
            for p in &mut config.providers {
                p.is_default = false;
            }
        }

        // 如果是第一个 Provider，自动设为默认
        if config.providers.is_empty() {
            provider.is_default = true;
        }

        config.providers.push(provider);
        self.save_to_file(&config)?;
        Ok(())
    }

    /// 原子去重添加（供一键导入）：在**同一把锁**内检查 name+type+base_url 是否已存在，
    /// 存在则报错、否则插入。避免并发导入「各自 list→都通过→都 insert」堆重复。
    pub fn add_provider_unique(&self, mut provider: Provider) -> Result<()> {
        if provider.id == SYSTEM_PROVIDER_ID {
            anyhow::bail!("Provider id '{}' is reserved", SYSTEM_PROVIDER_ID);
        }
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let dup = config.providers.iter().any(|e| {
            e.name == provider.name
                && e.provider_type == provider.provider_type
                && e.base_url == provider.base_url
        });
        if dup {
            anyhow::bail!("已存在同名同端点的 provider：{}", provider.name);
        }
        if provider.is_default {
            for p in &mut config.providers {
                p.is_default = false;
            }
        }
        if config.providers.is_empty() {
            provider.is_default = true;
        }
        config.providers.push(provider);
        self.save_to_file(&config)?;
        Ok(())
    }

    /// 更新 Provider
    pub fn update_provider(&self, provider: Provider) -> Result<()> {
        // 同 add_provider：保留 id 不可写入 providers.json。
        if provider.id == SYSTEM_PROVIDER_ID {
            anyhow::bail!("Provider id '{}' is reserved", SYSTEM_PROVIDER_ID);
        }

        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let pos = config
            .providers
            .iter()
            .position(|p| p.id == provider.id)
            .with_context(|| format!("Provider '{}' not found", provider.id))?;

        // 如果设为默认，取消其他的默认状态
        if provider.is_default {
            for p in &mut config.providers {
                p.is_default = false;
            }
        }

        config.providers[pos] = provider;
        self.save_to_file(&config)?;
        Ok(())
    }

    /// 删除 Provider
    /// 如果删除的是默认 Provider，自动将第一个剩余 Provider 设为默认
    pub fn remove_provider(&self, id: &str) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let was_default = config
            .providers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.is_default)
            .unwrap_or(false);

        config.providers.retain(|p| p.id != id);

        // 如果删除了默认 Provider，自动将第一个设为默认
        if was_default {
            if let Some(first) = config.providers.first_mut() {
                first.is_default = true;
            }
        }

        self.save_to_file(&config)?;
        Ok(())
    }

    /// 设置默认 Provider
    pub fn set_default(&self, id: &str) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        for p in &mut config.providers {
            p.is_default = p.id == id;
        }
        self.save_to_file(&config)?;
        Ok(())
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

        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let provider = if let Some(id) = provider_id {
            config.providers.iter().find(|p| p.id == id)
        } else {
            // 无指定时不注入任何 Provider env var
            // 默认回退来源由调用方决定（例如 Windows 默认 .codex）
            return HashMap::new();
        };

        match provider {
            Some(p) => self.resolve_env_vars(p),
            None => {
                warn!(
                    "[ProviderService] Provider '{}' not found, skipping env injection",
                    provider_id.unwrap_or("unknown")
                );
                HashMap::new()
            }
        }
    }

    /// 解析 Provider 环境变量，对 ConfigProfile 类型做特殊处理
    fn resolve_env_vars(&self, provider: &Provider) -> HashMap<String, String> {
        if provider.provider_type != ProviderType::ConfigProfile {
            return provider.to_env_vars();
        }

        let config_path = match &provider.config_dir {
            Some(dir) => dir,
            None => return HashMap::new(),
        };

        let path = Path::new(config_path);

        if path.is_dir() {
            // 目录模式：保持原有行为，设置 CLAUDE_CONFIG_DIR
            provider.to_env_vars()
        } else if path.is_file() {
            // 文件模式：读取 JSON 文件，解析 env 字段
            match Self::parse_env_config_file(path) {
                Ok(vars) => vars,
                Err(e) => {
                    warn!(
                        "[ProviderService] Failed to parse config file {}: {}",
                        config_path, e
                    );
                    HashMap::new()
                }
            }
        } else {
            warn!(
                "[ProviderService] Config path does not exist: {}",
                config_path
            );
            HashMap::new()
        }
    }

    /// 解析 ccswitch 格式的 JSON 配置文件
    /// 格式: { "env": { "KEY": "VALUE", ... } }
    fn parse_env_config_file(path: &Path) -> Result<HashMap<String, String>> {
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

        let mut vars = HashMap::new();
        for (key, value) in env_obj {
            if let Some(val_str) = value.as_str() {
                vars.insert(key.clone(), val_str.to_string());
            }
        }

        Ok(vars)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            is_default,
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
            is_default: false,
        }
    }

    fn new_service(dir: &tempfile::TempDir) -> ProviderService {
        ProviderService::new(dir.path().join("providers.json"))
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
    fn first_added_provider_becomes_default() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);

        service.add_provider(make_provider("a", false)).unwrap();

        let providers = service.list_providers();
        assert_eq!(providers.len(), 1);
        assert!(providers[0].is_default);
        assert_eq!(service.get_default_provider().unwrap().id, "a");
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
    fn remove_default_provider_promotes_first_remaining() {
        let dir = tempfile::tempdir().unwrap();
        let service = new_service(&dir);
        service.add_provider(make_provider("a", false)).unwrap();
        service.add_provider(make_provider("b", false)).unwrap();

        service.remove_provider("a").unwrap();

        let providers = service.list_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
        assert!(providers[0].is_default);
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
    fn get_default_provider_falls_back_to_first_when_none_marked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        // 手写配置：两个 provider 都没有 default 标记
        let config = ProviderConfig {
            providers: vec![make_provider("a", false), make_provider("b", false)],
        };
        std::fs::write(&path, serde_json::to_string(&config).unwrap()).unwrap();

        let service = ProviderService::new(path);
        assert_eq!(service.get_default_provider().unwrap().id, "a");
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
}
