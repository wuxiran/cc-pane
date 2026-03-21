use crate::models::ssh_machine::{SshMachine, SshMachineConfig};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// SSH 机器管理服务 — JSON 文件存储 + Mutex 内存状态
pub struct SshMachineService {
    config_path: PathBuf,
    config: Mutex<SshMachineConfig>,
}

impl SshMachineService {
    pub fn new(config_path: PathBuf) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();
        Self {
            config_path,
            config: Mutex::new(config),
        }
    }

    fn load_from_file(path: &Path) -> Result<SshMachineConfig> {
        let content =
            std::fs::read_to_string(path).with_context(|| "Failed to read ssh-machines config")?;
        let config: SshMachineConfig =
            serde_json::from_str(&content).with_context(|| "Failed to parse ssh-machines.json")?;
        Ok(config)
    }

    fn save_to_file(&self, config: &SshMachineConfig) -> Result<()> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(config)
            .with_context(|| "Failed to serialize ssh-machines config")?;
        std::fs::write(&self.config_path, content)
            .with_context(|| "Failed to write ssh-machines config")?;
        Ok(())
    }

    /// 列出所有 SSH 机器
    pub fn list(&self) -> Vec<SshMachine> {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .machines
            .clone()
    }

    /// 获取指定 SSH 机器
    pub fn get(&self, id: &str) -> Option<SshMachine> {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .machines
            .iter()
            .find(|m| m.id == id)
            .cloned()
    }

    /// 添加 SSH 机器（name 去重校验，大小写不敏感）
    pub fn add(&self, machine: SshMachine) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        if config
            .machines
            .iter()
            .any(|m| m.name.to_lowercase() == machine.name.to_lowercase())
        {
            anyhow::bail!("SSH machine with name '{}' already exists", machine.name);
        }

        // 先写文件再提交内存，避免保存失败后内存状态脏
        let mut new_config = config.clone();
        new_config.machines.push(machine);
        self.save_to_file(&new_config)?;
        *config = new_config;
        Ok(())
    }

    /// 更新 SSH 机器
    pub fn update(&self, machine: SshMachine) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let pos = config
            .machines
            .iter()
            .position(|m| m.id == machine.id)
            .with_context(|| format!("SSH machine '{}' not found", machine.id))?;

        // 检查名称是否与其他机器重复（大小写不敏感）
        if config
            .machines
            .iter()
            .any(|m| m.id != machine.id && m.name.to_lowercase() == machine.name.to_lowercase())
        {
            anyhow::bail!("SSH machine with name '{}' already exists", machine.name);
        }

        // 先写文件再提交内存
        let mut new_config = config.clone();
        new_config.machines[pos] = machine;
        self.save_to_file(&new_config)?;
        *config = new_config;
        Ok(())
    }

    /// 删除 SSH 机器（检查 ID 存在性）
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let len_before = config.machines.len();
        let mut new_config = config.clone();
        new_config.machines.retain(|m| m.id != id);

        if new_config.machines.len() == len_before {
            anyhow::bail!("SSH machine '{}' not found", id);
        }

        // 先写文件再提交内存
        self.save_to_file(&new_config)?;
        *config = new_config;
        Ok(())
    }
}
