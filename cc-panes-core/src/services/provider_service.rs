use crate::models::provider::{Provider, ProviderConfig, ProviderType};
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
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(config)
            .with_context(|| "Failed to serialize providers config")?;
        std::fs::write(&self.config_path, content)
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

    /// 添加 Provider
    pub fn add_provider(&self, mut provider: Provider) -> Result<()> {
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

    /// 更新 Provider
    pub fn update_provider(&self, provider: Provider) -> Result<()> {
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
    /// - provider_id 为 None 时不注入任何 env var，让 cc-switch 全局配置自然生效
    /// - 指定的 provider_id 找不到时返回空
    pub fn get_env_vars(&self, provider_id: Option<&str>) -> HashMap<String, String> {
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let provider = if let Some(id) = provider_id {
            config.providers.iter().find(|p| p.id == id)
        } else {
            // 无指定时不注入任何 Provider env var
            // 让 cc-switch 的全局配置自然生效
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
