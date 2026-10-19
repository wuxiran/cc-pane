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
    config: Arc<Mutex<SshMachineConfig>>,
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
            config: Arc::new(Mutex::new(config)),
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
        // has_stored_password 是 keyring 实时查询的运行时标志，请求里带回的
        // 值可能是陈旧的，落盘前一律清零（序列化时 false 会被跳过）。
        let mut sanitized = config.clone();
        for machine in &mut sanitized.machines {
            machine.has_stored_password = false;
        }
        let content = serde_json::to_string_pretty(&sanitized)
            .with_context(|| "Failed to serialize ssh-machines config")?;
        std::fs::write(&self.config_path, content)
            .with_context(|| "Failed to write ssh-machines config")?;
        Ok(())
    }

    /// 列出所有 SSH 机器
    pub fn list(&self) -> Vec<SshMachine> {
        let machines = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .machines
            .clone();
        machines
            .into_iter()
            .map(|machine| self.hydrate_machine(machine))
            .collect()
    }

    /// 获取指定 SSH 机器
    pub fn get(&self, id: &str) -> Option<SshMachine> {
        let machine = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .machines
            .iter()
            .find(|m| m.id == id)
            .cloned();
        machine.map(|machine| self.hydrate_machine(machine))
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
        self.validate_proxy_password_request(&machine, &request, false)?;

        let previous = config.clone();
        let mut new_config = previous.clone();
        new_config.machines.push(machine.clone());
        super::ssh_connection_service::validate_changed_machine_routes(
            &new_config.machines,
            &machine.id,
        )?;
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
        self.validate_proxy_password_request(&machine, &request, true)?;

        let previous_machine = config.machines[pos].clone();
        let previous = config.clone();
        let mut new_config = previous.clone();
        new_config.machines[pos] = machine.clone();
        super::ssh_connection_service::validate_changed_machine_routes(
            &new_config.machines,
            &machine.id,
        )?;
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
            // 代理密码与登录方式独立，删机器时一并清理，避免在 keyring 留下孤儿凭据。
            if machine.proxy.is_some() {
                self.credential_service.delete_proxy_password(id)?;
            }
        }
        self.save_to_file(&new_config)?;
        *config = new_config;
        Ok(())
    }

    fn hydrate_machine(&self, mut machine: SshMachine) -> SshMachine {
        if machine.auth_method == AuthMethod::Password {
            machine.has_stored_password = self.flag_or_false(
                &machine.id,
                "password",
                self.credential_service.has_password(&machine.id),
            );
        } else {
            machine.has_stored_password = false;
        }

        // 代理密码与 SSH 登录认证方式无关：用密钥登录的机器同样可能配了需要
        // 用户名密码的代理。仅在代理确实要求凭据时才反映存储状态，避免给
        // 匿名 socks5/http 代理显示「已保存密码」。
        let proxy_needs_password = machine
            .proxy
            .as_ref()
            .is_some_and(|proxy| proxy.requires_credentials());
        machine.has_stored_proxy_password = if proxy_needs_password {
            self.flag_or_false(
                &machine.id,
                "proxy password",
                self.credential_service.has_proxy_password(&machine.id),
            )
        } else {
            false
        };

        machine
    }

    /// 把凭据存在性查询结果转成布尔值；查询失败时只告警并返回 false。
    /// 保存/加载机器不应因为一次 keyring 探测失败而中断。
    fn flag_or_false(&self, id: &str, kind: &str, result: Result<bool>) -> bool {
        match result {
            Ok(flag) => flag,
            Err(error) => {
                warn!(
                    machine_id = %id,
                    credential_kind = %kind,
                    error = %error,
                    "Failed to determine whether SSH machine has the stored credential"
                );
                false
            }
        }
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

    /// 与登录密码相同的规则：勾选「记住代理密码」却没给新密码、也没已存密码时拒绝保存。
    /// 否则用户会以为凭据存好了，实际连接时才在代理握手上失败。
    fn validate_proxy_password_request(
        &self,
        machine: &SshMachine,
        request: &SshMachineUpsertRequest,
        is_update: bool,
    ) -> Result<()> {
        let proxy_needs_password = machine
            .proxy
            .as_ref()
            .is_some_and(|proxy| proxy.requires_credentials());
        if !proxy_needs_password || !request.remember_proxy_password {
            return Ok(());
        }

        let password_input = request.proxy_password_input.as_deref().unwrap_or("").trim();
        if !password_input.is_empty() {
            return Ok(());
        }

        if is_update && self.credential_service.has_proxy_password(&machine.id)? {
            return Ok(());
        }

        anyhow::bail!(
            "Proxy password is required to save this SSH proxy in the system credential store"
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

        self.apply_proxy_secret_update(machine, request, previous_machine)?;

        Ok(())
    }

    /// 维护代理密码：移除代理/改配凭据/取消记住时清理，记住时写入。
    /// 与 SSH 登录密码分开处理，二者在 keyring 中也是不同 account。
    fn apply_proxy_secret_update(
        &self,
        machine: &SshMachine,
        request: &SshMachineUpsertRequest,
        previous_machine: Option<&SshMachine>,
    ) -> Result<()> {
        let proxy_needs_password = machine
            .proxy
            .as_ref()
            .is_some_and(|proxy| proxy.requires_credentials());
        let had_proxy = previous_machine
            .map(|previous| previous.proxy.is_some())
            .unwrap_or(false);

        // 代理被移除、改成匿名代理、或用户明确要求清除时，删掉已存凭据。
        // 删除是幂等的，不存在的条目删除不报错。
        if request.clear_stored_proxy_password || (had_proxy && !proxy_needs_password) {
            self.credential_service.delete_proxy_password(&machine.id)?;
        }

        if proxy_needs_password && request.remember_proxy_password {
            if let Some(password) = request
                .proxy_password_input
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                self.credential_service
                    .store_proxy_password(&machine.id, password)?;
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
        let config = self.config.clone();
        let credentials = self.credential_service.clone();
        let machine_id = id.to_string();
        // Both waiting for a config mutation and reading Keychain credentials
        // can block. Do all preflight work away from the async runtime.
        let (machine, has_password) = tokio::task::spawn_blocking(move || {
            let machine = config
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .machines
                .iter()
                .find(|machine| machine.id == machine_id)
                .cloned()
                .with_context(|| format!("SSH machine '{}' not found", machine_id))?;
            Self::validate_ssh_field(&machine.host, "host")?;
            if let Some(ref user) = machine.user {
                Self::validate_ssh_field(user, "user")?;
            }
            if machine.auth_method == AuthMethod::Key {
                if let Some(ref file) = machine.identity_file {
                    Self::validate_ssh_field(file, "identityFile")?;
                }
            }
            let has_password = machine.auth_method != AuthMethod::Password
                || credentials.load_connection_password(&machine.id)?.is_some();
            Ok::<_, anyhow::Error>((machine, has_password))
        })
        .await
        .context("SSH connectivity preflight task failed")??;

        debug!(machine_id = %id, machine_name = %machine.name, "Checking SSH connectivity");

        let start = std::time::Instant::now();
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
                    message: format!("{error:#}"),
                    latency_ms: None,
                },
            });
        }

        let connection_service = self.connection_service.clone();
        let connection_machine = machine.clone();
        let connection_result = tokio::task::spawn_blocking(move || {
            let session = connection_service.connect_machine(&connection_machine)?;
            // libssh2 disconnect/drop can perform I/O too; keep cleanup off async workers.
            let _ = session.disconnect(None, "connectivity check complete", None);
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("SSH connectivity check task failed")?;
        let latency = start.elapsed().as_millis() as u64;

        match connection_result {
            Ok(()) => Ok(SshConnectivityResult {
                reachable: true,
                message: format!("Connected in {}ms", latency),
                latency_ms: Some(latency),
            }),
            Err(error) => Ok(SshConnectivityResult {
                reachable: false,
                message: format!("{error:#}"),
                latency_ms: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ssh_machine::{SshProxyConfig, SshProxyKind};
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
            proxy: None,
            jump_host: None,
            has_stored_password: false,
            has_stored_proxy_password: false,
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
            remember_proxy_password: false,
            proxy_password_input: None,
            clear_stored_proxy_password: false,
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
    fn hydrated_flag_reaches_serialized_response() {
        // 回归：has_stored_password 曾因 skip_serializing 从不进 JSON，
        // 前端拿不到 hasStoredPassword，导致每次重启都弹密码框。
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut request = fixture_request(fixture_machine("m1", AuthMethod::Password));
        request.remember_password = true;
        request.password_input = Some("secret".to_string());
        let saved = service.add(request).expect("add machine");

        let json = serde_json::to_string(&saved).expect("serialize response");
        assert!(json.contains("\"hasStoredPassword\":true"));

        let untrusted = fixture_machine("m2", AuthMethod::Key);
        let missing = serde_json::to_string(&untrusted).expect("serialize key machine");
        assert!(!missing.contains("hasStoredPassword"));
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

    fn fixture_proxy(username: Option<&str>) -> SshProxyConfig {
        SshProxyConfig {
            kind: SshProxyKind::Socks5,
            host: "proxy.local".to_string(),
            port: 1080,
            username: username.map(str::to_string),
        }
    }

    #[test]
    fn add_stores_proxy_password_separately_and_hydrates_flag() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut machine = fixture_machine("m1", AuthMethod::Key);
        machine.proxy = Some(fixture_proxy(Some("proxyuser")));
        let mut request = fixture_request(machine);
        request.remember_proxy_password = true;
        request.proxy_password_input = Some("proxy-secret".to_string());

        let saved = service.add(request).expect("add proxied machine");
        assert!(
            saved.has_stored_proxy_password,
            "a key-auth machine can still carry a proxy password"
        );
        // 代理密码不能污染 SSH 登录密码字段，也不能落盘。
        assert!(!saved.has_stored_password);
        let content =
            std::fs::read_to_string(dir.path().join("ssh-machines.json")).expect("config file");
        assert!(!content.contains("proxy-secret"));
    }

    #[test]
    fn anonymous_proxy_does_not_store_or_flag_a_password() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut machine = fixture_machine("m1", AuthMethod::Key);
        machine.proxy = Some(fixture_proxy(None));
        let mut request = fixture_request(machine);
        request.remember_proxy_password = true;
        request.proxy_password_input = Some("ignored".to_string());

        let saved = service.add(request).expect("add anonymous proxy machine");
        assert!(
            !saved.has_stored_proxy_password,
            "an anonymous proxy must not be shown as having a stored password"
        );
        assert!(!service
            .credential_service
            .has_proxy_password("m1")
            .expect("credential lookup"));
    }

    #[test]
    fn removing_proxy_clears_stored_proxy_password() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut machine = fixture_machine("m1", AuthMethod::Key);
        machine.proxy = Some(fixture_proxy(Some("proxyuser")));
        let mut add_request = fixture_request(machine);
        add_request.remember_proxy_password = true;
        add_request.proxy_password_input = Some("proxy-secret".to_string());
        service.add(add_request).expect("seed proxied machine");

        // 去掉代理后更新：已存凭据应被清理，避免孤儿 secret 残留 keyring。
        let cleared = fixture_machine("m1", AuthMethod::Key);
        let update_request = fixture_request(cleared);
        let updated = service
            .update(update_request)
            .expect("update without proxy");
        assert!(!updated.has_stored_proxy_password);
        assert!(!service
            .credential_service
            .has_proxy_password("m1")
            .expect("credential lookup"));
    }

    #[test]
    fn remove_deletes_proxy_password() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut machine = fixture_machine("m1", AuthMethod::Key);
        machine.proxy = Some(fixture_proxy(Some("proxyuser")));
        let mut add_request = fixture_request(machine);
        add_request.remember_proxy_password = true;
        add_request.proxy_password_input = Some("proxy-secret".to_string());
        service.add(add_request).expect("seed proxied machine");

        service.remove("m1").expect("remove machine");
        assert!(!service
            .credential_service
            .has_proxy_password("m1")
            .expect("credential lookup"));
    }

    #[test]
    fn remembering_proxy_password_without_a_value_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let service =
            SshMachineService::new_with_memory_credentials(dir.path().join("ssh-machines.json"));

        let mut machine = fixture_machine("m1", AuthMethod::Key);
        machine.proxy = Some(fixture_proxy(Some("proxyuser")));
        let mut request = fixture_request(machine);
        request.remember_proxy_password = true;
        // 没有新密码，也没有已存密码：必须拒绝，而不是静默存空。
        assert!(service.add(request).is_err());
    }
}
