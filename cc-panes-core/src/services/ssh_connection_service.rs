use crate::models::{AuthMethod, SshConnectionInfo, SshMachine};
use anyhow::{bail, Context, Result};
use ssh2::{CheckResult, KnownHostFileKind, Session};
use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::warn;

use super::SshCredentialService;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT_MS: u32 = 15_000;

pub struct SshConnectionService {
    credential_service: Arc<SshCredentialService>,
    known_hosts_path: PathBuf,
    known_hosts_lock: Mutex<()>,
}

struct ConnectionTarget<'a> {
    host: &'a str,
    port: u16,
    user: Option<&'a str>,
    auth_method: &'a AuthMethod,
    identity_file: Option<&'a str>,
    machine_id: Option<&'a str>,
}

impl SshConnectionService {
    pub fn new(credential_service: Arc<SshCredentialService>, known_hosts_path: PathBuf) -> Self {
        Self {
            credential_service,
            known_hosts_path,
            known_hosts_lock: Mutex::new(()),
        }
    }

    pub fn supports_embedded_terminal(info: &SshConnectionInfo) -> bool {
        match info.auth_method {
            Some(AuthMethod::Password) => info.machine_id.is_some(),
            Some(AuthMethod::Key) => info.identity_file.is_some(),
            Some(AuthMethod::Agent) => true,
            None => false,
        }
    }

    pub fn can_use_embedded_terminal(&self, info: &SshConnectionInfo) -> bool {
        if !Self::supports_embedded_terminal(info) {
            return false;
        }
        if info.auth_method != Some(AuthMethod::Password) {
            return true;
        }
        info.machine_id
            .as_deref()
            .and_then(|id| self.credential_service.load_connection_password(id).ok())
            .flatten()
            .is_some()
    }

    pub fn connect_machine(&self, machine: &SshMachine) -> Result<Session> {
        self.connect(ConnectionTarget {
            host: &machine.host,
            port: machine.port,
            user: machine.user.as_deref(),
            auth_method: &machine.auth_method,
            identity_file: machine.identity_file.as_deref(),
            machine_id: Some(&machine.id),
        })
    }

    /// Probe the TCP endpoint without starting an SSH handshake.
    ///
    /// This is used by connectivity checks when password authentication is
    /// configured but no password has been supplied yet. It keeps the check
    /// useful without creating a second system-ssh implementation.
    pub fn probe_machine(&self, machine: &SshMachine) -> Result<()> {
        let address = format_address(&machine.host, machine.port);
        open_tcp_stream(&address).map(|_| ())
    }

    pub fn connect_info(&self, info: &SshConnectionInfo) -> Result<Session> {
        let auth_method = info
            .auth_method
            .as_ref()
            .context("SSH authentication method is not configured")?;
        self.connect(ConnectionTarget {
            host: &info.host,
            port: info.port,
            user: info.user.as_deref(),
            auth_method,
            identity_file: info.identity_file.as_deref(),
            machine_id: info.machine_id.as_deref(),
        })
    }

    fn connect(&self, target: ConnectionTarget<'_>) -> Result<Session> {
        let address = format_address(target.host, target.port);
        let stream = open_tcp_stream(&address)?;
        stream.set_read_timeout(Some(CONNECT_TIMEOUT))?;
        stream.set_write_timeout(Some(CONNECT_TIMEOUT))?;

        let mut session = Session::new().context("Failed to create SSH session")?;
        session.set_tcp_stream(stream);
        session
            .handshake()
            .map_err(|error| anyhow::anyhow!("SSH handshake failed for {address}: {error}"))?;
        // Some OpenSSH servers reject the libssh2 key exchange when its
        // socket timeout is configured before the handshake. Apply runtime
        // timeouts only after protocol negotiation has completed.
        session.set_timeout(SESSION_TIMEOUT_MS);
        session.set_keepalive(true, 15);
        self.verify_host_key(&session, target.host, target.port)?;
        self.authenticate(&session, &target)?;
        Ok(session)
    }

    fn verify_host_key(&self, session: &Session, host: &str, port: u16) -> Result<()> {
        let _guard = self
            .known_hosts_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (key, key_type) = session
            .host_key()
            .context("SSH server did not provide a host key")?;
        let mut known_hosts = session
            .known_hosts()
            .context("Failed to create known-hosts store")?;
        if self.known_hosts_path.exists() {
            known_hosts
                .read_file(&self.known_hosts_path, KnownHostFileKind::OpenSSH)
                .with_context(|| {
                    format!(
                        "Failed to read application SSH known-hosts file {} (delete it to reset trusted hosts)",
                        self.known_hosts_path.display()
                    )
                })?;
        }

        match known_hosts.check_port(host, port, key) {
            CheckResult::Match => Ok(()),
            CheckResult::Mismatch => {
                bail!(
                    "SSH host key changed for {}:{}; connection refused",
                    host,
                    port
                )
            }
            CheckResult::Failure => bail!("Failed to verify SSH host key for {}:{}", host, port),
            CheckResult::NotFound => {
                if let Some(parent) = self.known_hosts_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let known_host = if port == 22 {
                    host.to_string()
                } else {
                    format!("[{host}]:{port}")
                };
                known_hosts
                    .add(&known_host, key, "cc-panes", key_type.into())
                    .context("Failed to trust SSH host key")?;
                self.persist_known_hosts(&known_hosts);
                Ok(())
            }
        }
    }

    /// 持久化首次信任（TOFU）的主机密钥。写入失败不阻断连接：
    /// 密钥已在内存中通过校验，下次连接会重试写入——与 OpenSSH 在
    /// known_hosts 不可写时的行为一致（告警并放行）。
    fn persist_known_hosts(&self, known_hosts: &ssh2::KnownHosts) {
        if let Err(error) =
            known_hosts.write_file(&self.known_hosts_path, KnownHostFileKind::OpenSSH)
        {
            warn!(
                path = %self.known_hosts_path.display(),
                %error,
                "Failed to save application SSH known-hosts file; host key trusted for this connection only"
            );
        }
    }

    fn authenticate(&self, session: &Session, target: &ConnectionTarget<'_>) -> Result<()> {
        let user = target
            .user
            .map(str::to_string)
            .unwrap_or_else(default_ssh_user);
        match target.auth_method {
            AuthMethod::Password => {
                let machine_id = target
                    .machine_id
                    .context("SSH machine ID is required for password authentication")?;
                let password = self
                    .credential_service
                    .load_connection_password(machine_id)?
                    .context("No SSH password is available for this machine")?;
                session
                    .userauth_password(&user, &password)
                    .context("SSH password authentication failed")?;
            }
            AuthMethod::Key => {
                let identity_file = target
                    .identity_file
                    .context("SSH identity file is not configured")?;
                let identity_file = expand_home_path(identity_file);
                session
                    .userauth_pubkey_file(&user, None, &identity_file, None)
                    .with_context(|| {
                        format!(
                            "SSH key authentication failed using {}",
                            identity_file.display()
                        )
                    })?;
            }
            AuthMethod::Agent => authenticate_with_agent(session, &user)?,
        }
        if !session.authenticated() {
            bail!("SSH authentication failed")
        }
        Ok(())
    }
}

fn format_address(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn open_tcp_stream(address: &str) -> Result<TcpStream> {
    let host = address
        .rsplit_once(':')
        .map(|(host, _)| host.trim_start_matches('[').trim_end_matches(']'))
        .unwrap_or(address);
    address
        .to_socket_addrs()
        .with_context(|| format!("Failed to resolve {host}"))?
        .find_map(|socket| TcpStream::connect_timeout(&socket, CONNECT_TIMEOUT).ok())
        .with_context(|| format!("Failed to connect to {address}"))
}

fn authenticate_with_agent(session: &Session, user: &str) -> Result<()> {
    let mut agent = session.agent().context("Failed to open SSH agent")?;
    agent.connect().context("Failed to connect to SSH agent")?;
    agent
        .list_identities()
        .context("Failed to list SSH agent identities")?;
    for identity in agent
        .identities()
        .context("Failed to read SSH agent identities")?
    {
        if agent.userauth(user, &identity).is_ok() {
            return Ok(());
        }
    }
    bail!("SSH agent did not contain an accepted identity")
}

fn default_ssh_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string())
}

fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(suffix) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(suffix);
        }
    }
    Path::new(path).to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(auth_method: Option<AuthMethod>) -> SshConnectionInfo {
        SshConnectionInfo {
            host: "server.example.com".to_string(),
            port: 22,
            user: Some("dev".to_string()),
            remote_path: "/srv/app".to_string(),
            identity_file: None,
            machine_id: None,
            auth_method,
        }
    }

    #[test]
    fn embedded_terminal_requires_resolvable_authentication() {
        assert!(!SshConnectionService::supports_embedded_terminal(&info(
            None
        )));

        let mut password = info(Some(AuthMethod::Password));
        assert!(!SshConnectionService::supports_embedded_terminal(&password));
        password.machine_id = Some("machine-1".to_string());
        assert!(SshConnectionService::supports_embedded_terminal(&password));

        let mut key = info(Some(AuthMethod::Key));
        assert!(!SshConnectionService::supports_embedded_terminal(&key));
        key.identity_file = Some("~/.ssh/id_ed25519".to_string());
        assert!(SshConnectionService::supports_embedded_terminal(&key));

        assert!(SshConnectionService::supports_embedded_terminal(&info(
            Some(AuthMethod::Agent,)
        )));
    }

    #[test]
    fn password_terminal_requires_a_available_connection_password() {
        let credentials = Arc::new(SshCredentialService::new_memory());
        let service = SshConnectionService::new(credentials.clone(), PathBuf::from("known-hosts"));
        let mut password = info(Some(AuthMethod::Password));
        password.machine_id = Some("machine-1".to_string());
        assert!(!service.can_use_embedded_terminal(&password));

        credentials.store_temporary_password("machine-1", "secret");
        assert!(service.can_use_embedded_terminal(&password));
    }

    #[test]
    fn known_hosts_persist_failure_does_not_propagate() {
        // 目标路径是一个已存在的目录时 write_file 必然失败；
        // persist_known_hosts 只允许告警，不允许把失败抛回连接流程。
        let dir = std::env::temp_dir().join(format!("cc-panes-kh-dir-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let credentials = Arc::new(SshCredentialService::new_memory());
        let service = SshConnectionService::new(credentials, dir.clone());

        let session = Session::new().expect("create ssh session");
        let known_hosts = session.known_hosts().expect("create known-hosts store");
        service.persist_known_hosts(&known_hosts);

        fs::remove_dir(&dir).expect("cleanup temp dir");
    }
}
