use crate::models::ssh_machine::{AuthMethod, SshMachine, SshMachineConfig};
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tracing::debug;

/// SSH 连通性检测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectivityResult {
    pub reachable: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

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

    /// 校验 SSH 字段值：不可为空、不可以 `-` 开头（防止被 SSH 当作选项）、不含空白
    fn validate_ssh_field(value: &str, field_name: &str) -> Result<()> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            anyhow::bail!("{} cannot be empty", field_name);
        }
        if trimmed.starts_with('-') {
            anyhow::bail!("{} cannot start with '-'", field_name);
        }
        if trimmed != value {
            anyhow::bail!("{} cannot have leading/trailing whitespace", field_name);
        }
        Ok(())
    }

    /// 检测 SSH 机器连通性
    ///
    /// 使用 `ssh -o ConnectTimeout=5 -o BatchMode=yes [opts] host exit` 测试连接。
    /// BatchMode=yes 禁止交互式密码提示，仅测试非交互 reachability。
    /// 使用临时 UserKnownHostsFile 避免修改用户的 known_hosts。
    pub async fn check_connectivity(&self, id: &str) -> Result<SshConnectivityResult> {
        let machine = self.get(id).with_context(|| {
            format!("SSH machine '{}' not found", id)
        })?;

        // 输入校验：防止 host/user/identityFile 被 SSH 解析为选项
        Self::validate_ssh_field(&machine.host, "host")?;
        if let Some(ref u) = machine.user {
            Self::validate_ssh_field(u, "user")?;
        }
        if let Some(ref f) = machine.identity_file {
            if machine.auth_method == AuthMethod::Key {
                Self::validate_ssh_field(f, "identityFile")?;
            }
        }

        let ssh_path = which::which("ssh")
            .map_err(|_| anyhow::anyhow!("ssh not found in PATH"))?;

        // 临时 known_hosts 文件（NUL on Windows, /dev/null on Unix）
        let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };

        let mut args = Vec::new();

        // 连接超时
        args.extend(["-o", "ConnectTimeout=5"]);

        // 统一使用 BatchMode=yes：禁止所有交互提示（含 password 模式）
        // 这意味着 password 模式仅测试 TCP reachability + SSH 握手，不测试密码认证
        args.extend(["-o", "BatchMode=yes"]);

        // 使用临时 known_hosts 文件：连通性检测不应修改用户的 known_hosts
        let known_hosts_opt = format!("UserKnownHostsFile={}", null_path);
        args.extend(["-o", "StrictHostKeyChecking=no"]);
        args.extend(["-o", &known_hosts_opt]);

        // 端口
        let port_str = machine.port.to_string();
        if machine.port != 22 {
            args.extend(["-p", &port_str]);
        }

        // 身份文件
        if let Some(ref id_file) = machine.identity_file {
            if machine.auth_method == AuthMethod::Key {
                args.extend(["-i", id_file]);
            }
        }

        // 目标：使用 -- 分隔选项和目标，防止 user@host 被解析为选项
        args.push("--");
        let target = match &machine.user {
            Some(u) => format!("{}@{}", u, machine.host),
            None => machine.host.clone(),
        };
        args.push(&target);
        args.push("exit");

        debug!(machine_id = %id, machine_name = %machine.name, "Checking SSH connectivity");

        let start = std::time::Instant::now();
        let output = tokio::process::Command::new(&ssh_path)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| "Failed to execute ssh command")?;
        let latency = start.elapsed().as_millis() as u64;

        if output.status.success() {
            Ok(SshConnectivityResult {
                reachable: true,
                message: format!("Connected in {}ms", latency),
                latency_ms: Some(latency),
            })
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let msg = stderr.lines().next().unwrap_or("Connection failed").to_string();
            Ok(SshConnectivityResult {
                reachable: false,
                message: msg,
                latency_ms: None,
            })
        }
    }
}
