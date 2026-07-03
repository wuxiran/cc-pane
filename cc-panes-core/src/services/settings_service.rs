use crate::models::settings::AppSettings;
use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Mutex;
use tracing::info;

/// 设置服务 - 管理应用配置
pub struct SettingsService {
    config_path: PathBuf,
    settings: Mutex<AppSettings>,
}

impl SettingsService {
    pub fn new() -> Self {
        let config_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(crate::utils::APP_DIR_NAME)
            .join("config.toml");

        Self::new_with_config_path(config_path)
    }

    pub fn new_with_config_path(config_path: PathBuf) -> Self {
        let mut settings = Self::load_from_file(&config_path).unwrap_or_default();
        settings.merge_missing_defaults();

        info!(config_path = %config_path.display(), "Settings loaded");

        Self {
            config_path,
            settings: Mutex::new(settings),
        }
    }

    /// 从文件加载配置
    fn load_from_file(path: &PathBuf) -> Result<AppSettings> {
        let content = std::fs::read_to_string(path).with_context(|| "Failed to read config")?;
        let settings: AppSettings =
            toml::from_str(&content).with_context(|| "Failed to parse config.toml")?;
        Ok(settings)
    }

    /// 保存配置到文件
    fn save_to_file(&self, settings: &AppSettings) -> Result<()> {
        // 确保目录存在
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content =
            toml::to_string_pretty(settings).with_context(|| "Failed to serialize settings")?;
        std::fs::write(&self.config_path, content).with_context(|| "Failed to write config")?;
        Ok(())
    }

    /// 获取当前设置
    pub fn get_settings(&self) -> AppSettings {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 更新设置
    pub fn update_settings(&self, mut new_settings: AppSettings) -> Result<()> {
        new_settings.merge_missing_defaults();
        self.save_to_file(&new_settings)?;
        info!("Settings updated and saved");
        let mut current = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        *current = new_settings;
        Ok(())
    }

    /// 获取代理环境变量
    pub fn get_proxy_env_vars(&self) -> std::collections::HashMap<String, String> {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .proxy
            .to_env_vars()
    }
}

impl Default for SettingsService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("config.toml")
    }

    #[test]
    fn missing_config_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let service = SettingsService::new_with_config_path(temp_config_path(&dir));

        let settings = service.get_settings();
        let defaults = {
            let mut d = AppSettings::default();
            d.merge_missing_defaults();
            d
        };
        assert_eq!(settings.general.language, defaults.general.language);
        assert_eq!(settings.terminal.font_size, defaults.terminal.font_size);
        // 不应因读取失败而创建文件
        assert!(!temp_config_path(&dir).exists());
    }

    #[test]
    fn corrupt_config_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_config_path(&dir);
        std::fs::write(&path, "this is [ not valid toml").unwrap();

        let service = SettingsService::new_with_config_path(path);
        let settings = service.get_settings();
        assert_eq!(settings.general.language, "zh-CN");
    }

    #[test]
    fn loads_values_from_existing_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_config_path(&dir);
        std::fs::write(
            &path,
            r#"
[general]
autoStart = false
language = "en-US"
"#,
        )
        .unwrap();

        let service = SettingsService::new_with_config_path(path);
        assert_eq!(service.get_settings().general.language, "en-US");
    }

    #[test]
    fn load_applies_merge_missing_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_config_path(&dir);
        // font_size 越界，加载后应被归一化
        std::fs::write(
            &path,
            r#"
[terminal]
fontSize = 1
fontFamily = "monospace"
cursorStyle = "block"
cursorBlink = true
scrollback = 5000
"#,
        )
        .unwrap();

        let service = SettingsService::new_with_config_path(path);
        let settings = service.get_settings();
        assert_ne!(settings.terminal.font_size, 1);
        assert_eq!(settings.terminal.scrollback, 5_000);
    }

    #[test]
    fn update_settings_persists_to_file_and_memory() {
        let dir = tempfile::tempdir().unwrap();
        // 父目录不存在时应自动创建
        let path = dir.path().join("nested").join("config.toml");
        let service = SettingsService::new_with_config_path(path.clone());

        let mut settings = service.get_settings();
        settings.general.language = "en-US".to_string();
        settings.proxy.enabled = true;
        settings.proxy.host = "127.0.0.1".to_string();
        settings.proxy.port = 7890;
        settings.proxy.proxy_type = "http".to_string();
        service.update_settings(settings).unwrap();

        // 内存中已更新
        assert_eq!(service.get_settings().general.language, "en-US");
        assert!(service.get_settings().proxy.enabled);

        // 磁盘上可被新实例读回（round-trip）
        let reloaded = SettingsService::new_with_config_path(path);
        let settings = reloaded.get_settings();
        assert_eq!(settings.general.language, "en-US");
        assert_eq!(settings.proxy.host, "127.0.0.1");
        assert_eq!(settings.proxy.port, 7890);
    }

    #[test]
    fn get_proxy_env_vars_empty_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let service = SettingsService::new_with_config_path(temp_config_path(&dir));
        assert!(service.get_proxy_env_vars().is_empty());
    }

    #[test]
    fn get_proxy_env_vars_reflects_enabled_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let service = SettingsService::new_with_config_path(temp_config_path(&dir));

        let mut settings = service.get_settings();
        settings.proxy.enabled = true;
        settings.proxy.proxy_type = "http".to_string();
        settings.proxy.host = "proxy.local".to_string();
        settings.proxy.port = 8080;
        service.update_settings(settings).unwrap();

        let vars = service.get_proxy_env_vars();
        assert_eq!(
            vars.get("HTTP_PROXY"),
            Some(&"http://proxy.local:8080".to_string())
        );
        assert_eq!(
            vars.get("ALL_PROXY"),
            Some(&"http://proxy.local:8080".to_string())
        );
    }
}
