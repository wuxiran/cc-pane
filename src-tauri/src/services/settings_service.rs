use crate::models::settings::AppSettings;
use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Mutex;

/// 设置服务 - 管理应用配置
pub struct SettingsService {
    config_path: PathBuf,
    settings: Mutex<AppSettings>,
}

impl SettingsService {
    pub fn new() -> Self {
        let config_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cc-panes")
            .join("config.toml");

        let settings = Self::load_from_file(&config_path).unwrap_or_default();

        Self {
            config_path,
            settings: Mutex::new(settings),
        }
    }

    /// 从文件加载配置
    fn load_from_file(path: &PathBuf) -> Result<AppSettings> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read config: {}", path.display()))?;
        let settings: AppSettings = toml::from_str(&content)
            .with_context(|| "Failed to parse config.toml")?;
        Ok(settings)
    }

    /// 保存配置到文件
    fn save_to_file(&self, settings: &AppSettings) -> Result<()> {
        // 确保目录存在
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(settings)
            .with_context(|| "Failed to serialize settings")?;
        std::fs::write(&self.config_path, content)
            .with_context(|| format!("Failed to write config: {}", self.config_path.display()))?;
        Ok(())
    }

    /// 获取当前设置
    pub fn get_settings(&self) -> AppSettings {
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 更新设置
    pub fn update_settings(&self, new_settings: AppSettings) -> Result<()> {
        self.save_to_file(&new_settings)?;
        let mut current = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        *current = new_settings;
        Ok(())
    }

    /// 获取代理环境变量
    pub fn get_proxy_env_vars(&self) -> std::collections::HashMap<String, String> {
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).proxy.to_env_vars()
    }
}

impl Default for SettingsService {
    fn default() -> Self {
        Self::new()
    }
}
