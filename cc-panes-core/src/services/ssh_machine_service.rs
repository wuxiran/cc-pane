use crate::models::ssh_machine::{
    AuthMethod, SshMachine, SshMachineConfig, SshMachineUpsertRequest,
};
use crate::services::{SshConnectionService, SshCredentialService};
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
    connection_service: Arc<SshConnectionService>,
}

impl SshMachineService {
    pub fn new(config_path: PathBuf, credential_service: Arc<SshCredentialService>) -> Self {
        let known_hosts_path = config_path
            .parent()
            .map(|path| path.join("ssh-known-hosts"))
            .unwrap_or_else(|| PathBuf::from("ssh-known-hosts"));
        let connection_service = Arc::new(SshConnectionService::new(
            credential_service.clone(),
            known_hosts_path,
        ));
        Self::with_connection_service(config_path, credential_service, connection_service)
    }

    pub fn with_connection_service(
        config_path: PathBuf,
        credential_service: Arc<SshCredentialService>,
        connection_service: Arc<SshConnectionService>,
    ) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();
        Self {
            config_path,
            config: Mutex::new(config),
            credential_service,
            connection_service,
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

    pub fn load_password(&self, id: &str) -> Result<Option<String>> {
        self.credential_service.load_password(id)
    }

    pub fn load_connection_password(&self, id: &str) -> Result<Option<String>> {
        self.credential_service.load_connection_password(id)
    }

    pub fn store_password(&self, id: &str, password: &str) -> Result<()> {
        let machine = self
            .get(id)
            .with_context(|| format!("SSH machine '{}' not found", id))?;
        if machine.auth_method != AuthMethod::Password {
            anyhow::bail!("SSH machine '{}' does not use password authentication", id);
        }
        if password.is_empty() {
            anyhow::bail!("SSH password cannot be empty");
        }
        self.credential_service.store_password(id, password)
    }

    pub fn store_temporary_password(&self, id: &str, password: &str) -> Result<()> {
        let machine = self
            .get(id)
            .with_context(|| format!("SSH machine '{}' not found", id))?;
        if machine.auth_method != AuthMethod::Password {
            anyhow::bail!("SSH machine '{}' does not use password authentication", id);
        }
        if password.is_empty() {
            anyhow::bail!("SSH password cannot be empty");
        }
        self.credential_service
            .store_temporary_password(id, password);
        Ok(())
    }

    pub fn clear_temporary_password(&self, id: &str) {
        self.credential_service.clear_temporary_password(id);
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
        if let Err(error) = self.apply_secret_update(&machine, &request, None) {
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

        let previous_machine = config.machines[pos].clone();
        let previous = config.clone();
        let mut new_config = previous.clone();
        new_config.machines[pos] = machine.clone();
        self.save_to_file(&new_config)?;
        if let Err(error) = self.apply_secret_update(&machine, &request, Some(&previous_machine)) {
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

        if let Some(machine) = config.machines.iter().find(|machine| machine.id == id) {
            if machine.auth_method == AuthMethod::Password {
                self.credential_service.delete_password(id)?;
            }
        }
        self.save_to_file(&new_config)?;
        *config = new_config;
        Ok(())
    }

    fn hydrate_machine(&self, mut machine: SshMachine) -> SshMachine {
        if machine.auth_method != AuthMethod::Password {
            machine.has_stored_password = false;
            return machine;
        }

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
        previous_machine: Option<&SshMachine>,
    ) -> Result<()> {
        let changed_from_password = previous_machine
            .map(|previous| {
                previous.auth_method == AuthMethod::Password
                    && machine.auth_method != AuthMethod::Password
            })
            .unwrap_or(false);

        if request.clear_stored_password || changed_from_password {
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

        debug!(machine_id = %id, machine_name = %machine.name, "Checking SSH connectivity");

        let start = std::time::Instant::now();
        let has_password = if machine.auth_method == AuthMethod::Password {
            self.credential_service
                .load_connection_password(&machine.id)?
                .is_some()
        } else {
            true
        };
        if machine.auth_method == AuthMethod::Password && !has_password {
            let probe_service = self.connection_service.clone();
            let probe_machine = machine.clone();
            let probe_result =
                tokio::task::spawn_blocking(move || probe_service.probe_machine(&probe_machine))
                    .await
                    .context("SSH reachability probe task failed")?;
            let latency = start.elapsed().as_millis() as u64;
            return Ok(match probe_result {
                Ok(()) => SshConnectivityResult {
                    reachable: true,
                    message: "SSH host reachable; enter a password to validate authentication"
                        .to_string(),
                    latency_ms: Some(latency),
                },
                Err(error) => SshConnectivityResult {
                    reachable: false,
                    message: error.to_string(),
                    latency_ms: None,
                },
            });
        }

        let connection_service = self.connection_service.clone();
        let connection_machine = machine.clone();
        let connection_result = tokio::task::spawn_blocking(move || {
            connection_service.connect_machine(&connection_machine)
        })
        .await
        .context("SSH connectivity check task failed")?;
        let latency = start.elapsed().as_millis() as u64;

        match connection_result {
            Ok(session) => {
                let _ = session.disconnect(None, "connectivity check complete", None);
                Ok(SshConnectivityResult {
                    reachable: true,
                    message: format!("Connected in {}ms", latency),
                    latency_ms: Some(latency),
                })
            }
            Err(error) => Ok(SshConnectivityResult {
                reachable: false,
                message: error.to_string(),
                latency_ms: None,
            }),
        }
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
    fn add_key_machine_does_not_touch_credentials() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let saved = service
            .add(fixture_request(fixture_machine("m1", AuthMethod::Key)))
            .expect("add key machine");

        assert!(!saved.has_stored_password);
        assert!(!service
            .credential_service
            .has_password("m1")
            .expect("credential lookup"));
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
