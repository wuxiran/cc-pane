use crate::models::{
    AuthMethod, SshConnectionInfo, SshJumpHost, SshMachine, SshMachineConfig, SshProxyConfig,
};
use anyhow::{bail, Context, Result};
use ssh2::{CheckResult, KnownHostFileKind, Session};
use std::fs;
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::warn;

use super::ssh_proxy_bridge::{
    establish_jump_tunnel, format_address, open_proxy_tunnel, open_tcp_stream,
};
use super::SshCredentialService;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT_MS: u32 = 15_000;
/// 机器清单文件名，与 known-hosts 同目录（见 `SshMachineService::new`）。
const MACHINES_FILE_NAME: &str = "ssh-machines.json";

pub struct SshConnectionService {
    credential_service: Arc<SshCredentialService>,
    known_hosts_path: PathBuf,
    /// 机器清单路径，由 known-hosts 的同级目录推导；用于按 `machine_id`
    /// 反查代理/跳板配置。`SshConnectionInfo` 不携带路由字段，这是唯一来源。
    machines_path: Option<PathBuf>,
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

/// 一次连接的路由决策，从机器配置克隆而来（字段都很小）。
///
/// 用 owned 结构而非借用 `&SshMachine`，是为了让 `connect_info` 能使用从
/// 磁盘反查出的机器，而不必让借用跨出查找作用域。
#[derive(Default)]
struct MachineRoute {
    proxy: Option<SshProxyConfig>,
    /// 代理密码的 keyring 主体 id；内联跳板借用所属机器的代理时沿用其 id。
    proxy_credential_id: Option<String>,
    jump: Option<SshJumpHost>,
}

impl MachineRoute {
    fn from_machine(machine: &SshMachine) -> Self {
        Self {
            proxy: machine.proxy.clone(),
            proxy_credential_id: machine.proxy.as_ref().map(|_| machine.id.clone()),
            jump: machine.jump_host.clone(),
        }
    }
}

/// Apply the same single-hop rule when saving, probing, and connecting. Only the
/// changed machine and its dependents need revalidation; unrelated legacy errors
/// must not prevent repairing another saved route.
pub(super) fn validate_changed_machine_routes(
    machines: &[SshMachine],
    changed_id: &str,
) -> Result<()> {
    for machine in machines {
        let Some(jump) = machine
            .jump_host
            .as_ref()
            .filter(|j| j.uses_machine_reference())
        else {
            continue;
        };
        let jump_id = jump.machine_id.as_deref().unwrap_or_default();
        if machine.id != changed_id && jump_id != changed_id {
            continue;
        }
        let target = machines
            .iter()
            .find(|candidate| candidate.id == jump_id)
            .with_context(|| format!("SSH jump host machine {jump_id} was not found"))?;
        validate_jump_target(Some(&machine.id), target)?;
    }
    Ok(())
}

fn validate_jump_target(owner_id: Option<&str>, target: &SshMachine) -> Result<()> {
    if owner_id == Some(target.id.as_str()) {
        bail!("SSH jump host {} refers to itself", target.id);
    }
    if target.jump_host.is_some() {
        bail!(
            "SSH jump host {} is itself configured with a jump host; nested jump hosts are not supported",
            target.id
        );
    }
    Ok(())
}

impl SshConnectionService {
    pub fn new(credential_service: Arc<SshCredentialService>, known_hosts_path: PathBuf) -> Self {
        let machines_path = known_hosts_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.join(MACHINES_FILE_NAME));
        Self {
            credential_service,
            known_hosts_path,
            machines_path,
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
        // 配了代理/跳板的机器绝不能回退系统 ssh：回退不会带 ProxyCommand / -J，
        // 会静默绕过代理去直连目标——这是安全相关的正确性问题，不是体验问题。
        // 因此这类机器强制走内嵌；凭据缺失时让内嵌连接显式报错，而不是绕道。
        if self.is_routed_connection(info) {
            return true;
        }
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

    /// 该连接信息对应的机器是否配了代理或跳板。
    ///
    /// `SshConnectionInfo` 本身不携带路由字段（保持其结构不变），只能按
    /// `machine_id` 从机器清单反查。清单不存在（没有保存过机器）时按直连
    /// 处理，维持旧行为；清单损坏时无法判定路由，宁可强制内嵌——系统 ssh
    /// 回退会静默绕过代理。
    fn is_routed_connection(&self, info: &SshConnectionInfo) -> bool {
        match self.lookup_machine(info.machine_id.as_deref()) {
            Ok(machine) => machine.is_some_and(|m| m.uses_routed_connection()),
            Err(error) => {
                warn!(%error, "SSH route lookup failed; forcing the embedded terminal to avoid bypassing a configured proxy");
                true
            }
        }
    }

    /// 按 id 反查机器。清单不存在返回 `Ok(None)`；读取或解析失败返回 `Err`，
    /// 让调用方有机会失败关闭而不是静默降级。
    fn lookup_machine(&self, machine_id: Option<&str>) -> Result<Option<SshMachine>> {
        let (Some(machine_id), Some(machines_path)) = (machine_id, self.machines_path.as_ref())
        else {
            return Ok(None);
        };
        Self::load_machine(machines_path, machine_id).context("Failed to read the SSH machine list")
    }

    pub fn connect_machine(&self, machine: &SshMachine) -> Result<Session> {
        let address = format_address(&machine.host, machine.port);
        // 这里已持有完整配置，直接用，避免再回磁盘查一遍（也避免清单还没落盘时查不到）。
        let route = MachineRoute::from_machine(machine);
        let stream = self.open_routed_stream(&route, &address, &machine.host, machine.port)?;
        self.establish_session(
            stream,
            &address,
            &ConnectionTarget {
                host: &machine.host,
                port: machine.port,
                user: machine.user.as_deref(),
                auth_method: &machine.auth_method,
                identity_file: machine.identity_file.as_deref(),
                machine_id: Some(&machine.id),
            },
        )
    }

    /// Probe the TCP endpoint without starting an SSH handshake.
    ///
    /// This is used by connectivity checks when password authentication is
    /// configured but no password has been supplied yet. It keeps the check
    /// useful without creating a second system-ssh implementation.
    ///
    /// 配了代理/跳板的机器，直连目标必然不通（那正是它们存在的原因），所以
    /// 改探「第一跳」：代理端点或跳板端点。这不需要任何凭据，也能真实反映
    /// 链路是否可达。
    pub fn probe_machine(&self, machine: &SshMachine) -> Result<()> {
        if let Some(jump) = machine.jump_host.as_ref() {
            return self.probe_jump_hop(machine, jump);
        }
        self.probe_direct_hop(machine)
    }

    fn probe_direct_hop(&self, machine: &SshMachine) -> Result<()> {
        if let Some(proxy) = machine.proxy.as_ref() {
            let address = format_address(&proxy.host, proxy.port);
            return open_tcp_stream(&address).map(|_| ()).with_context(|| {
                format!("Failed to reach {} proxy {address}", proxy.kind.as_str())
            });
        }
        let address = format_address(&machine.host, machine.port);
        open_tcp_stream(&address).map(|_| ())
    }

    fn probe_jump_hop(&self, machine: &SshMachine, jump: &SshJumpHost) -> Result<()> {
        // A saved jump may use a proxy, but it may not itself have a jump. Do
        // not recurse: old or manually edited cyclic configs must fail safely.
        if jump.uses_machine_reference() {
            let jump_id = jump.machine_id.as_deref().unwrap_or_default();
            let jump_machine = self.referenced_jump_machine(Some(&machine.id), jump_id)?;
            return self.probe_direct_hop(&jump_machine);
        }
        // 内联跳板：探跳板主机，或所属主机的代理端点。
        if let Some(proxy) = machine.proxy.as_ref() {
            let address = format_address(&proxy.host, proxy.port);
            return open_tcp_stream(&address).map(|_| ()).with_context(|| {
                format!("Failed to reach {} proxy {address}", proxy.kind.as_str())
            });
        }
        let host = jump
            .host
            .as_deref()
            .context("SSH jump host is missing a host")?;
        let address = format_address(host, jump.port);
        open_tcp_stream(&address)
            .map(|_| ())
            .with_context(|| format!("Failed to reach jump host {address}"))
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
        let route = self.resolve_route(&target)?;
        let stream = self.open_routed_stream(&route, &address, target.host, target.port)?;
        self.establish_session(stream, &address, &target)
    }

    /// 确定这次连接该走直连、代理还是跳板。
    ///
    /// `connect_machine` 已带完整配置所以不走这里；`connect_info` 只有
    /// `machine_id`，需要从磁盘反查。清单损坏时直接报错而不降级为直连：
    /// 那会让配了代理的机器静默绕过代理。
    fn resolve_route(&self, target: &ConnectionTarget<'_>) -> Result<MachineRoute> {
        Ok(match self.lookup_machine(target.machine_id)? {
            Some(machine) => MachineRoute::from_machine(&machine),
            None => MachineRoute::default(),
        })
    }

    fn load_machine(path: &Path, machine_id: &str) -> io::Result<Option<SshMachine>> {
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            // 文件不存在等价于「没有保存过机器」，不是错误。
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        // 解析失败必须显式报错而不是静默直连：那会让配了代理的机器绕过代理。
        let config: SshMachineConfig = serde_json::from_str(&content)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Ok(config
            .machines
            .into_iter()
            .find(|machine| machine.id == machine_id))
    }

    /// 按路由打开承载 SSH 协议的 TCP 流。
    fn open_routed_stream(
        &self,
        route: &MachineRoute,
        address: &str,
        host: &str,
        port: u16,
    ) -> Result<TcpStream> {
        // 跳板优先：跳板会话自身可以复用该主机的代理配置。
        if let Some(jump) = route.jump.as_ref() {
            return self.open_jump_stream(route, jump, host, port);
        }
        if let Some(proxy) = route.proxy.as_ref() {
            return self.open_proxy_stream(route, proxy, host, port);
        }
        open_tcp_stream(address)
    }

    /// 经代理建到目标主机的隧道。代理密码只从 keyring 取，取不到就明确报错。
    fn open_proxy_stream(
        &self,
        route: &MachineRoute,
        proxy: &SshProxyConfig,
        host: &str,
        port: u16,
    ) -> Result<TcpStream> {
        let password = self.load_proxy_password(route, proxy)?;
        open_proxy_tunnel(proxy, host, port, password.as_deref())
    }

    fn load_proxy_password(
        &self,
        route: &MachineRoute,
        proxy: &SshProxyConfig,
    ) -> Result<Option<String>> {
        if !proxy.requires_credentials() {
            return Ok(None);
        }
        let credential_id = route.proxy_credential_id.as_deref().context(
            "SSH proxy credentials require a saved machine id; save the machine before connecting",
        )?;
        self.credential_service
            .load_connection_proxy_password(credential_id)?
            .context("No SSH proxy password is available for this machine")
            .map(Some)
    }

    /// 先认证跳板会话，再在其上开 `direct-tcpip` 拿到目标的本地 socket。
    fn open_jump_stream(
        &self,
        route: &MachineRoute,
        jump: &SshJumpHost,
        host: &str,
        port: u16,
    ) -> Result<TcpStream> {
        let jump_session = self.connect_jump_session(route, jump)?;
        establish_jump_tunnel(jump_session, host, port)
    }

    fn connect_jump_session(&self, route: &MachineRoute, jump: &SshJumpHost) -> Result<Session> {
        if jump.uses_machine_reference() {
            return self.connect_referenced_jump(jump.machine_id.as_deref().unwrap_or_default());
        }
        let inline_host = jump
            .host
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .context("SSH jump host requires either a saved machine reference or a host")?;

        let target = ConnectionTarget {
            host: inline_host,
            port: jump.port,
            user: jump.user.as_deref(),
            // 内联跳板不存自己的凭据，所以只用 key 或 agent；密码形式
            // 没有可用的 keyring 主体，让用户改用「引用已保存机器」。
            auth_method: if jump.identity_file.is_some() {
                &AuthMethod::Key
            } else {
                &AuthMethod::Agent
            },
            identity_file: jump.identity_file.as_deref(),
            machine_id: None,
        };
        let address = format_address(inline_host, jump.port);
        // 跳板自身也复用所属主机的代理配置，这样「代理后面的跳板」可用。
        let stream = match route.proxy.as_ref() {
            Some(proxy) => self.open_proxy_stream(route, proxy, inline_host, jump.port)?,
            None => open_tcp_stream(&address)?,
        };
        self.establish_session(stream, &address, &target)
    }

    fn referenced_jump_machine(
        &self,
        owner_id: Option<&str>,
        jump_machine_id: &str,
    ) -> Result<SshMachine> {
        let jump_machine = self
            .lookup_machine(Some(jump_machine_id))?
            .with_context(|| format!("SSH jump host machine {jump_machine_id} was not found"))?;
        validate_jump_target(owner_id, &jump_machine)?;
        Ok(jump_machine)
    }

    /// 跳板引用了另一台已保存机器：仅允许该机器直连或使用代理。
    fn connect_referenced_jump(&self, jump_machine_id: &str) -> Result<Session> {
        let jump_machine = self.referenced_jump_machine(None, jump_machine_id)?;
        // 跳板机自己的代理凭据属于它自己的 id，不能沿用所属主机的。
        let jump_route = MachineRoute::from_machine(&jump_machine);
        let address = format_address(&jump_machine.host, jump_machine.port);
        let stream =
            self.open_routed_stream(&jump_route, &address, &jump_machine.host, jump_machine.port)?;
        self.establish_session(
            stream,
            &address,
            &ConnectionTarget {
                host: &jump_machine.host,
                port: jump_machine.port,
                user: jump_machine.user.as_deref(),
                auth_method: &jump_machine.auth_method,
                identity_file: jump_machine.identity_file.as_deref(),
                machine_id: Some(&jump_machine.id),
            },
        )
    }

    /// 在已打通的传输流上完成 SSH 握手、主机密钥校验与认证。
    ///
    /// 直连、代理、跳板三条路径共用这里，保证 known-hosts 与认证语义一致。
    fn establish_session(
        &self,
        stream: TcpStream,
        address: &str,
        target: &ConnectionTarget<'_>,
    ) -> Result<Session> {
        stream.set_read_timeout(Some(CONNECT_TIMEOUT))?;
        stream.set_write_timeout(Some(CONNECT_TIMEOUT))?;

        let mut session = Session::new().context("Failed to create SSH session")?;
        session.set_tcp_stream(stream);
        super::ssh_handshake::handshake(&mut session, CONNECT_TIMEOUT)
            .map_err(|error| anyhow::anyhow!("SSH handshake failed for {address}: {error}"))?;
        // Some OpenSSH servers reject the libssh2 key exchange when its
        // socket timeout is configured before the handshake. Apply runtime
        // timeouts only after protocol negotiation has completed.
        session.set_timeout(SESSION_TIMEOUT_MS);
        session.set_keepalive(true, 15);
        self.verify_host_key(&session, target.host, target.port)?;
        self.authenticate(&session, target)?;
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

#[cfg(test)]
#[path = "ssh_connection_service/route_tests.rs"]
mod route_tests;

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
    use crate::models::SshProxyKind;

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

    /// 在临时目录里放一份 `ssh-machines.json`，known-hosts 指向同目录，
    /// 这样 `machines_path` 能被正确推导出来。
    fn service_with_machines(tag: &str, machines_json: &str) -> (SshConnectionService, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cc-panes-route-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let machines_path = dir.join(MACHINES_FILE_NAME);
        fs::write(&machines_path, machines_json).expect("write machines");
        let credentials = Arc::new(SshCredentialService::new_memory());
        let service = SshConnectionService::new(credentials, dir.join("ssh-known-hosts"));
        (service, dir)
    }

    fn machine_json(id: &str, host: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","host":"{host}","port":22,"authMethod":"agent","createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}}"#
        )
    }

    #[test]
    fn routed_machine_forces_embedded_terminal_even_without_password() {
        // 配了代理的机器没有可用密码时，仍必须强制内嵌：系统 ssh 回退会
        // 静默绕过代理直连目标。这是安全相关的正确性，不是体验问题。
        let proxy_json = r#"{"machines":[{"id":"m1","name":"m1","host":"target.example","port":22,"authMethod":"password","proxy":{"kind":"socks5","host":"proxy.example","port":1080},"createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}]}"#;
        let (service, dir) = service_with_machines("routed-proxy", proxy_json);
        let mut routed = info(Some(AuthMethod::Password));
        routed.machine_id = Some("m1".to_string());
        assert!(
            service.can_use_embedded_terminal(&routed),
            "a proxied machine must never fall back to system ssh"
        );

        // 跳板同理。
        let jump_json = r#"{"machines":[{"id":"m2","name":"m2","host":"target.example","port":22,"authMethod":"password","jumpHost":{"host":"jump.example","port":22},"createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}]}"#;
        let (service2, dir2) = service_with_machines("routed-jump", jump_json);
        let mut jump = info(Some(AuthMethod::Password));
        jump.machine_id = Some("m2".to_string());
        assert!(service2.can_use_embedded_terminal(&jump));

        // 直连机器维持原行为：无密码时不强制内嵌。
        let direct_json = format!(
            r#"{{"machines":[{}]}}"#,
            machine_json("m3", "direct.example")
        );
        let (service3, _) = service_with_machines("direct", &direct_json);
        let mut direct = info(Some(AuthMethod::Password));
        direct.machine_id = Some("m3".to_string());
        assert!(!service3.can_use_embedded_terminal(&direct));

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn corrupt_machine_list_fails_closed_to_embedded() {
        // 清单损坏时无法判定路由，必须强制内嵌而不是静默直连绕过代理。
        let (service, dir) = service_with_machines("corrupt", "{not valid json");
        let mut password = info(Some(AuthMethod::Password));
        password.machine_id = Some("m1".to_string());
        assert!(
            service.can_use_embedded_terminal(&password),
            "an unreadable route config must fail closed, not fall back to system ssh"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_machine_list_keeps_legacy_direct_behavior() {
        // 清单不存在（从没保存过机器）时，旧密码机器仍按原规则判定，
        // 不能因为新增了路由查找就改变升级前的行为。
        let dir = std::env::temp_dir().join(format!("cc-panes-noroute-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let credentials = Arc::new(SshCredentialService::new_memory());
        let service = SshConnectionService::new(credentials, dir.join("ssh-known-hosts"));
        assert!(
            service.machines_path.is_some(),
            "machines path must be derived from the known-hosts parent"
        );
        let mut password = info(Some(AuthMethod::Password));
        password.machine_id = Some("m1".to_string());
        assert!(!service.can_use_embedded_terminal(&password));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn route_lookup_reads_proxy_and_jump_from_disk() {
        let json = format!(
            r#"{{"machines":[{},{{"id":"r1","name":"r1","host":"target.example","port":2222,"authMethod":"key","identityFile":"~/.ssh/id_ed25519","proxy":{{"kind":"http","host":"proxy.example","port":8080,"username":"proxyuser"}},"jumpHost":{{"machineId":"{}","port":22}},"createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}}]}}"#,
            machine_json("jump1", "jump.example"),
            "jump1"
        );
        let (service, dir) = service_with_machines("lookup", &json);
        let machine = service
            .lookup_machine(Some("r1"))
            .expect("lookup ok")
            .expect("machine found");
        let route = MachineRoute::from_machine(&machine);
        let proxy = route.proxy.expect("proxy configured");
        assert_eq!(proxy.kind, SshProxyKind::Http);
        assert!(proxy.requires_credentials());
        assert_eq!(
            route.proxy_credential_id.as_deref(),
            Some("r1"),
            "proxy password must be keyed by the owning machine id"
        );
        let jump = route.jump.expect("jump configured");
        assert!(jump.uses_machine_reference());
        // 引用的跳板机本身可被解析，且它没有再嵌套跳板。
        let jump_machine = service
            .lookup_machine(jump.machine_id.as_deref())
            .expect("lookup ok")
            .expect("jump machine found");
        assert_eq!(jump_machine.host, "jump.example");
        assert!(jump_machine.jump_host.is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
