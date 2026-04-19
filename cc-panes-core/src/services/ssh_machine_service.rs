use crate::models::ssh_machine::{
    AuthMethod, SshMachine, SshMachineConfig, SshMachineUpsertRequest,
};
use crate::services::SshCredentialService;
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{debug, warn};

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
    credential_service: Arc<SshCredentialService>,
}

impl SshMachineService {
    pub fn new(config_path: PathBuf, credential_service: Arc<SshCredentialService>) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();
        Self {
            config_path,
            config: Mutex::new(config),
            credential_service,
        }
    }

    #[cfg(test)]
    fn new_with_memory_credentials(config_path: PathBuf) -> Self {
        Self::new(config_path, Arc::new(SshCredentialService::new_memory()))
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
            .into_iter()
            .map(|machine| self.hydrate_machine(machine))
            .collect()
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
            .map(|machine| self.hydrate_machine(machine))
    }

    /// 添加 SSH 机器（name 去重校验，大小写不敏感）
    pub fn add(&self, request: SshMachineUpsertRequest) -> Result<SshMachine> {
        let machine = request.machine.clone();
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        if config
            .machines
            .iter()
            .any(|m| m.name.to_lowercase() == machine.name.to_lowercase())
        {
            anyhow::bail!("SSH machine with name '{}' already exists", machine.name);
        }

        self.validate_password_request(&machine, &request, false)?;

        let previous = config.clone();
        let mut new_config = previous.clone();
        new_config.machines.push(machine.clone());
        self.save_to_file(&new_config)?;
        if let Err(error) = self.apply_secret_update(&machine, &request) {
            warn!(
                machine_id = %machine.id,
                error = %error,
                "Rolling back SSH machine add after credential update failure"
            );
            let _ = self.save_to_file(&previous);
            return Err(error);
        }
        *config = new_config;
        Ok(self.hydrate_machine(machine))
    }

    /// 更新 SSH 机器
    pub fn update(&self, request: SshMachineUpsertRequest) -> Result<SshMachine> {
        let machine = request.machine.clone();
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());

        let pos = config
            .machines
            .iter()
            .position(|m| m.id == machine.id)
            .with_context(|| format!("SSH machine '{}' not found", machine.id))?;

        if config
            .machines
            .iter()
            .any(|m| m.id != machine.id && m.name.to_lowercase() == machine.name.to_lowercase())
        {
            anyhow::bail!("SSH machine with name '{}' already exists", machine.name);
        }

        self.validate_password_request(&machine, &request, true)?;

        let previous = config.clone();
        let mut new_config = previous.clone();
        new_config.machines[pos] = machine.clone();
        self.save_to_file(&new_config)?;
        if let Err(error) = self.apply_secret_update(&machine, &request) {
            warn!(
                machine_id = %machine.id,
                error = %error,
                "Rolling back SSH machine update after credential update failure"
            );
            let _ = self.save_to_file(&previous);
            return Err(error);
        }
        *config = new_config;
        Ok(self.hydrate_machine(machine))
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

        self.save_to_file(&new_config)?;
        self.credential_service.delete_password(id)?;
        *config = new_config;
        Ok(())
    }

    fn hydrate_machine(&self, mut machine: SshMachine) -> SshMachine {
        machine.has_stored_password = match self.credential_service.has_password(&machine.id) {
            Ok(has_password) => has_password,
            Err(error) => {
                warn!(
                    machine_id = %machine.id,
                    error = %error,
                    "Failed to determine whether SSH machine has a stored password"
                );
                false
            }
        };
        machine
    }

    fn validate_password_request(
        &self,
        machine: &SshMachine,
        request: &SshMachineUpsertRequest,
        is_update: bool,
    ) -> Result<()> {
        if machine.auth_method != AuthMethod::Password || !request.remember_password {
            return Ok(());
        }

        let password_input = request.password_input.as_deref().unwrap_or("").trim();
        if !password_input.is_empty() {
            return Ok(());
        }

        if is_update && self.credential_service.has_password(&machine.id)? {
            return Ok(());
        }

        anyhow::bail!(
            "Password is required to save this SSH machine in the system credential store"
        );
    }

    fn apply_secret_update(
        &self,
        machine: &SshMachine,
        request: &SshMachineUpsertRequest,
    ) -> Result<()> {
        if request.clear_stored_password || machine.auth_method != AuthMethod::Password {
            self.credential_service.delete_password(&machine.id)?;
        }

        if machine.auth_method == AuthMethod::Password && request.remember_password {
            if let Some(password) = request
                .password_input
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                self.credential_service
                    .store_password(&machine.id, password)?;
            }
        }

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
        let machine = self
            .get(id)
            .with_context(|| format!("SSH machine '{}' not found", id))?;

        Self::validate_ssh_field(&machine.host, "host")?;
        if let Some(ref u) = machine.user {
            Self::validate_ssh_field(u, "user")?;
        }
        if let Some(ref f) = machine.identity_file {
            if machine.auth_method == AuthMethod::Key {
                Self::validate_ssh_field(f, "identityFile")?;
            }
        }

        let ssh_path = which::which("ssh").map_err(|_| anyhow::anyhow!("ssh not found in PATH"))?;
        let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };

        let mut args = Vec::new();
        args.extend(["-o", "ConnectTimeout=5"]);
        args.extend(["-o", "BatchMode=yes"]);

        let known_hosts_opt = format!("UserKnownHostsFile={}", null_path);
        args.extend(["-o", "StrictHostKeyChecking=no"]);
        args.extend(["-o", &known_hosts_opt]);

        let port_str = machine.port.to_string();
        if machine.port != 22 {
            args.extend(["-p", &port_str]);
        }

        if let Some(ref id_file) = machine.identity_file {
            if machine.auth_method == AuthMethod::Key {
                args.extend(["-i", id_file]);
            }
        }

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
            return Ok(SshConnectivityResult {
                reachable: true,
                message: format!("Connected in {}ms", latency),
                latency_ms: Some(latency),
            });
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if machine.auth_method == AuthMethod::Password && Self::looks_like_auth_challenge(&stderr) {
            return Ok(SshConnectivityResult {
                reachable: true,
                message: "SSH host reachable; password/MFA were not validated in connectivity test"
                    .to_string(),
                latency_ms: Some(latency),
            });
        }

        let msg = stderr
            .lines()
            .next()
            .unwrap_or("Connection failed")
            .to_string();
        Ok(SshConnectivityResult {
            reachable: false,
            message: msg,
            latency_ms: None,
        })
    }

    fn looks_like_auth_challenge(stderr: &str) -> bool {
        let lower = stderr.to_ascii_lowercase();
        lower.contains("permission denied")
            || lower.contains("password:")
            || lower.contains("keyboard-interactive")
            || lower.contains("verification code")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture_machine(id: &str, auth_method: AuthMethod) -> SshMachine {
        SshMachine {
            id: id.to_string(),
            name: format!("machine-{}", id),
            host: "devbox.local".to_string(),
            port: 22,
            user: Some("dev".to_string()),
            auth_method,
            identity_file: None,
            description: Some("notes".to_string()),
            default_path: Some("~/projects".to_string()),
            tags: vec!["prod".to_string()],
            has_stored_password: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn fixture_request(machine: SshMachine) -> SshMachineUpsertRequest {
        SshMachineUpsertRequest {
            machine,
            remember_password: false,
            password_input: None,
            clear_stored_password: false,
        }
    }

    #[test]
    fn add_hydrates_has_stored_password_and_keeps_secret_out_of_file() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut request = fixture_request(fixture_machine("m1", AuthMethod::Password));
        request.remember_password = true;
        request.password_input = Some("secret".to_string());

        let saved = service.add(request).expect("add machine");
        assert!(saved.has_stored_password);

        let content =
            std::fs::read_to_string(dir.path().join("ssh-machines.json")).expect("config file");
        assert!(content.contains("\"description\": \"notes\""));
        assert!(!content.contains("secret"));
        assert!(!content.contains("hasStoredPassword"));
    }

    #[test]
    fn update_can_clear_stored_password() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut add_request = fixture_request(fixture_machine("m1", AuthMethod::Password));
        add_request.remember_password = true;
        add_request.password_input = Some("secret".to_string());
        service.add(add_request).expect("seed machine");

        let mut update_request = fixture_request(fixture_machine("m1", AuthMethod::Password));
        update_request.clear_stored_password = true;
        let updated = service.update(update_request).expect("update machine");
        assert!(!updated.has_stored_password);
    }

    #[test]
    fn remove_deletes_stored_password() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut add_request = fixture_request(fixture_machine("m1", AuthMethod::Password));
        add_request.remember_password = true;
        add_request.password_input = Some("secret".to_string());
        service.add(add_request).expect("seed machine");

        service.remove("m1").expect("remove machine");
        assert!(!service
            .credential_service
            .has_password("m1")
            .expect("credential lookup"));
    }
}
