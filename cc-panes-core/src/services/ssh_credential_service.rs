use crate::utils::APP_DIR_NAME;
use anyhow::{Context, Result};
use std::sync::Arc;

trait CredentialBackend: Send + Sync {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()>;
    fn get_password(&self, machine_id: &str) -> Result<Option<String>>;
    fn delete_password(&self, machine_id: &str) -> Result<()>;
}

struct SystemCredentialBackend {
    service_name: String,
}

impl SystemCredentialBackend {
    fn new() -> Self {
        Self {
            service_name: format!("cc-panes:{}:ssh-machine", APP_DIR_NAME),
        }
    }

    fn entry(&self, machine_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service_name, machine_id)
            .with_context(|| format!("Failed to open system credential entry for {}", machine_id))
    }
}

impl CredentialBackend for SystemCredentialBackend {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.entry(machine_id)?
            .set_password(password)
            .with_context(|| format!("Failed to store password for {}", machine_id))?;
        Ok(())
    }

    fn get_password(&self, machine_id: &str) -> Result<Option<String>> {
        match self.entry(machine_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to read stored password for {}", machine_id)),
        }
    }

    fn delete_password(&self, machine_id: &str) -> Result<()> {
        match self.entry(machine_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to delete stored password for {}", machine_id)),
        }
    }
}

#[cfg(test)]
struct MemoryCredentialBackend {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryCredentialBackend {
    fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

#[cfg(test)]
impl CredentialBackend for MemoryCredentialBackend {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(machine_id.to_string(), password.to_string());
        Ok(())
    }

    fn get_password(&self, machine_id: &str) -> Result<Option<String>> {
        Ok(self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(machine_id)
            .cloned())
    }

    fn delete_password(&self, machine_id: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(machine_id);
        Ok(())
    }
}

pub struct SshCredentialService {
    backend: Arc<dyn CredentialBackend>,
}

impl SshCredentialService {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(SystemCredentialBackend::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_memory() -> Self {
        Self {
            backend: Arc::new(MemoryCredentialBackend::new()),
        }
    }

    pub fn store_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.backend.set_password(machine_id, password)
    }

    pub fn load_password(&self, machine_id: &str) -> Result<Option<String>> {
        self.backend.get_password(machine_id)
    }

    pub fn has_password(&self, machine_id: &str) -> Result<bool> {
        Ok(self.load_password(machine_id)?.is_some())
    }

    pub fn delete_password(&self, machine_id: &str) -> Result<()> {
        self.backend.delete_password(machine_id)
    }
}
