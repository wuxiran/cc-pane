//! 设备注册表：本机记住的其他 CC-Panes（docs/111-multi-device.md）。
//!
//! - 设备清单存 `devices.json`；访问令牌存系统 keyring（不落盘明文）。
//! - SSH 设备按需建立本地端口转发（`SshPortForward`），断线后下次访问自动重建。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};

use crate::models::{
    Device, DeviceAddRequest, DeviceConfig, DeviceConnection, DeviceEndpoint, DeviceSummary,
};
use crate::utils::atomic_file::write_atomic;
use crate::utils::APP_DIR_NAME;

use super::ssh_port_forward::SshPortForward;
use super::{SshConnectionService, SshMachineService};

pub const DEVICES_FILE: &str = "devices.json";

/// 设备令牌存储。生产用系统 keyring，测试用内存。
pub trait DeviceTokenStore: Send + Sync {
    fn set(&self, device_id: &str, token: &str) -> Result<()>;
    fn get(&self, device_id: &str) -> Result<Option<String>>;
    fn delete(&self, device_id: &str) -> Result<()>;
}

pub struct KeyringDeviceTokenStore {
    service_name: String,
}

impl Default for KeyringDeviceTokenStore {
    fn default() -> Self {
        Self {
            service_name: format!("cc-panes:{APP_DIR_NAME}:device"),
        }
    }
}

impl KeyringDeviceTokenStore {
    fn entry(&self, device_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service_name, device_id)
            .with_context(|| format!("Failed to open credential entry for device {device_id}"))
    }
}

impl DeviceTokenStore for KeyringDeviceTokenStore {
    fn set(&self, device_id: &str, token: &str) -> Result<()> {
        self.entry(device_id)?
            .set_password(token)
            .with_context(|| format!("Failed to store the token for device {device_id}"))
    }

    fn get(&self, device_id: &str) -> Result<Option<String>> {
        match self.entry(device_id)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to read the token for device {device_id}")),
        }
    }

    fn delete(&self, device_id: &str) -> Result<()> {
        match self.entry(device_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to delete the token for device {device_id}")),
        }
    }
}

#[derive(Default)]
pub struct MemoryDeviceTokenStore {
    tokens: Mutex<HashMap<String, String>>,
}

impl DeviceTokenStore for MemoryDeviceTokenStore {
    fn set(&self, device_id: &str, token: &str) -> Result<()> {
        self.tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(device_id.to_string(), token.to_string());
        Ok(())
    }

    fn get(&self, device_id: &str) -> Result<Option<String>> {
        Ok(self
            .tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(device_id)
            .cloned())
    }

    fn delete(&self, device_id: &str) -> Result<()> {
        self.tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(device_id);
        Ok(())
    }
}

pub struct DeviceService {
    config_path: PathBuf,
    config: Mutex<DeviceConfig>,
    tokens: Arc<dyn DeviceTokenStore>,
    ssh_machines: Arc<SshMachineService>,
    ssh_connection: Arc<SshConnectionService>,
    forwards: Mutex<HashMap<String, SshPortForward>>,
    /// keyring 读取可能很慢（macOS 还可能弹授权），终端每次读写都要解析端点，必须缓存。
    token_cache: Mutex<HashMap<String, Option<String>>>,
}

impl DeviceService {
    pub fn new(
        config_path: PathBuf,
        tokens: Arc<dyn DeviceTokenStore>,
        ssh_machines: Arc<SshMachineService>,
        ssh_connection: Arc<SshConnectionService>,
    ) -> Self {
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<DeviceConfig>(&text).ok())
            .unwrap_or_default();
        Self {
            config_path,
            config: Mutex::new(config),
            tokens,
            ssh_machines,
            ssh_connection,
            forwards: Mutex::new(HashMap::new()),
            token_cache: Mutex::new(HashMap::new()),
        }
    }

    fn token(&self, id: &str) -> Result<Option<String>> {
        if let Some(cached) = self
            .token_cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(id)
        {
            return Ok(cached.clone());
        }
        let token = self.tokens.get(id)?;
        self.token_cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(id.to_string(), token.clone());
        Ok(token)
    }

    fn forget_cached_token(&self, id: &str) {
        self.token_cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(id);
    }

    pub fn ssh_machines(&self) -> &Arc<SshMachineService> {
        &self.ssh_machines
    }

    pub fn ssh_connection(&self) -> &Arc<SshConnectionService> {
        &self.ssh_connection
    }

    pub fn list(&self) -> Vec<DeviceSummary> {
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .devices
            .clone()
            .into_iter()
            .map(|device| self.summarize(device))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Device> {
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .devices
            .iter()
            .find(|device| device.id == id)
            .cloned()
    }

    pub fn summary(&self, id: &str) -> Option<DeviceSummary> {
        self.get(id).map(|device| self.summarize(device))
    }

    fn summarize(&self, device: Device) -> DeviceSummary {
        let has_token = self.token(&device.id).ok().flatten().is_some();
        let target_label = match &device.connection {
            DeviceConnection::Ssh { machine_id, .. } => self
                .ssh_machines
                .get(machine_id)
                .map(|machine| match machine.user.as_deref() {
                    Some(user) if !user.is_empty() => format!("{user}@{}", machine.host),
                    _ => machine.host,
                })
                .unwrap_or_else(|| format!("ssh:{machine_id} (missing)")),
            DeviceConnection::Direct { base_url } => base_url.clone(),
        };
        DeviceSummary {
            device,
            has_token,
            target_label,
        }
    }

    pub fn add(&self, request: DeviceAddRequest) -> Result<Device> {
        let name = request.name.trim();
        if name.is_empty() {
            bail!("Device name is required");
        }
        let connection = normalize_connection(request.connection)?;
        if let DeviceConnection::Ssh { machine_id, .. } = &connection {
            if self.ssh_machines.get(machine_id).is_none() {
                bail!("SSH machine {machine_id} does not exist");
            }
        }
        let device = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            connection,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Some(token) = request.token.as_deref().map(str::trim) {
            if !token.is_empty() {
                self.tokens.set(&device.id, token)?;
            }
        }
        let mut config = self.config.lock().unwrap_or_else(|err| err.into_inner());
        config.devices.push(device.clone());
        self.save(&config)?;
        Ok(device)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<Device> {
        let name = name.trim();
        if name.is_empty() {
            bail!("Device name is required");
        }
        let mut config = self.config.lock().unwrap_or_else(|err| err.into_inner());
        let device = config
            .devices
            .iter_mut()
            .find(|device| device.id == id)
            .with_context(|| format!("Device {id} not found"))?;
        device.name = name.to_string();
        let device = device.clone();
        self.save(&config)?;
        Ok(device)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.drop_forward(id);
        let mut config = self.config.lock().unwrap_or_else(|err| err.into_inner());
        config.devices.retain(|device| device.id != id);
        self.save(&config)?;
        drop(config);
        self.forget_cached_token(id);
        self.tokens.delete(id)
    }

    pub fn set_token(&self, id: &str, token: &str) -> Result<()> {
        if self.get(id).is_none() {
            bail!("Device {id} not found");
        }
        self.forget_cached_token(id);
        self.tokens.set(id, token.trim())
    }

    /// 解析访问端点。SSH 设备会在需要时（首次 / 断线后）建立端口转发——阻塞调用。
    pub fn endpoint(&self, id: &str) -> Result<DeviceEndpoint> {
        let device = self
            .get(id)
            .with_context(|| format!("Device {id} not found"))?;
        let token = self.token(id)?;
        let base_url = match &device.connection {
            DeviceConnection::Direct { base_url } => base_url.clone(),
            DeviceConnection::Ssh {
                machine_id,
                remote_port,
            } => {
                let addr = self.ensure_forward(id, machine_id, *remote_port)?;
                format!("http://{addr}")
            }
        };
        Ok(DeviceEndpoint { base_url, token })
    }

    /// 丢弃某台设备的端口转发（请求连续失败时调用，下次访问会重建）。
    pub fn drop_forward(&self, id: &str) {
        let removed = self
            .forwards
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(id);
        drop(removed);
    }

    fn ensure_forward(
        &self,
        id: &str,
        machine_id: &str,
        remote_port: u16,
    ) -> Result<std::net::SocketAddr> {
        let mut forwards = self.forwards.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(forward) = forwards.get(id) {
            if forward.is_alive() {
                return Ok(forward.local_addr());
            }
        }
        forwards.remove(id);
        let machine = self
            .ssh_machines
            .get(machine_id)
            .with_context(|| format!("SSH machine {machine_id} no longer exists"))?;
        let session = self
            .ssh_connection
            .connect_machine(&machine)
            .with_context(|| format!("Failed to connect to {}", machine.name))?;
        let forward = SshPortForward::start(session, "127.0.0.1", remote_port)?;
        let addr = forward.local_addr();
        forwards.insert(id.to_string(), forward);
        Ok(addr)
    }

    fn save(&self, config: &DeviceConfig) -> Result<()> {
        let json = serde_json::to_string_pretty(config)?;
        write_atomic(&self.config_path, json)
    }
}

fn normalize_connection(connection: DeviceConnection) -> Result<DeviceConnection> {
    match connection {
        DeviceConnection::Direct { base_url } => {
            let base_url = base_url.trim().trim_end_matches('/').to_string();
            if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
                bail!("Device address must start with http:// or https://");
            }
            Ok(DeviceConnection::Direct { base_url })
        }
        DeviceConnection::Ssh {
            machine_id,
            remote_port,
        } => {
            if machine_id.trim().is_empty() {
                bail!("SSH machine is required");
            }
            if remote_port == 0 {
                bail!("Remote port must be between 1 and 65535");
            }
            Ok(DeviceConnection::Ssh {
                machine_id: machine_id.trim().to_string(),
                remote_port,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::SshCredentialService;

    fn service() -> (DeviceService, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let credentials = Arc::new(SshCredentialService::new_memory());
        let machines = Arc::new(SshMachineService::new(
            dir.path().join("ssh-machines.json"),
            credentials.clone(),
        ));
        let connection = Arc::new(SshConnectionService::new(
            credentials,
            dir.path().join("ssh-known-hosts"),
        ));
        (
            DeviceService::new(
                dir.path().join(DEVICES_FILE),
                Arc::new(MemoryDeviceTokenStore::default()),
                machines,
                connection,
            ),
            dir,
        )
    }

    #[test]
    fn direct_device_roundtrip_persists_and_keeps_token_out_of_file() {
        let (service, dir) = service();
        let device = service
            .add(DeviceAddRequest {
                name: " Studio ".into(),
                connection: DeviceConnection::Direct {
                    base_url: "http://studio.tailnet:8080/".into(),
                },
                token: Some("ccp_dev_secret".into()),
            })
            .expect("add");
        assert_eq!(device.name, "Studio");
        let endpoint = service.endpoint(&device.id).expect("endpoint");
        assert_eq!(endpoint.base_url, "http://studio.tailnet:8080");
        assert_eq!(endpoint.token.as_deref(), Some("ccp_dev_secret"));

        let file = std::fs::read_to_string(dir.path().join(DEVICES_FILE)).expect("file");
        assert!(!file.contains("ccp_dev_secret"));
        assert!(service.list()[0].has_token);

        service.remove(&device.id).expect("remove");
        assert!(service.list().is_empty());
    }

    #[test]
    fn rejects_bad_input() {
        let (service, _dir) = service();
        assert!(service
            .add(DeviceAddRequest {
                name: "x".into(),
                connection: DeviceConnection::Direct {
                    base_url: "studio:8080".into()
                },
                token: None,
            })
            .is_err());
        assert!(service
            .add(DeviceAddRequest {
                name: "x".into(),
                connection: DeviceConnection::Ssh {
                    machine_id: "missing".into(),
                    remote_port: 18765
                },
                token: None,
            })
            .is_err());
    }
}
