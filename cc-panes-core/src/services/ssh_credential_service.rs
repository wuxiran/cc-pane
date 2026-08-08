use crate::utils::APP_DIR_NAME;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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

struct MemoryCredentialBackend {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl MemoryCredentialBackend {
    fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

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
    temporary_passwords: Mutex<HashMap<String, String>>,
}

impl Default for SshCredentialService {
    fn default() -> Self {
        Self::new()
    }
}

impl SshCredentialService {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(SystemCredentialBackend::new()),
            temporary_passwords: Mutex::new(HashMap::new()),
        }
    }

    pub fn new_memory() -> Self {
        Self {
            backend: Arc::new(MemoryCredentialBackend::new()),
            temporary_passwords: Mutex::new(HashMap::new()),
        }
    }

    pub fn store_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.backend.set_password(machine_id, password)?;
        self.clear_temporary_password(machine_id);
        Ok(())
    }

    pub fn store_temporary_password(&self, machine_id: &str, password: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(machine_id.to_string(), password.to_string());
    }

    pub fn load_password(&self, machine_id: &str) -> Result<Option<String>> {
        self.backend.get_password(machine_id)
    }

    pub fn load_connection_password(&self, machine_id: &str) -> Result<Option<String>> {
        if let Some(password) = self
            .temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(machine_id)
            .cloned()
        {
            return Ok(Some(password));
        }
        self.load_password(machine_id)
    }

    pub fn has_password(&self, machine_id: &str) -> Result<bool> {
        Ok(self.load_password(machine_id)?.is_some())
    }

    pub fn delete_password(&self, machine_id: &str) -> Result<()> {
        self.backend.delete_password(machine_id)?;
        self.clear_temporary_password(machine_id);
        Ok(())
    }

    pub fn clear_temporary_password(&self, machine_id: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(machine_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_password_is_used_for_connections_without_becoming_persistent() {
        let service = SshCredentialService::new_memory();
        service.store_temporary_password("m1", "temporary");

        assert_eq!(service.load_password("m1").unwrap(), None);
        assert_eq!(
            service.load_connection_password("m1").unwrap().as_deref(),
            Some("temporary")
        );

        service.store_password("m1", "persisted").unwrap();
        assert_eq!(
            service.load_connection_password("m1").unwrap().as_deref(),
            Some("persisted")
        );
    }
}
