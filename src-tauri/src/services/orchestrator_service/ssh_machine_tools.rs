//! SSH 机器（「设备」视图里的主机）的 MCP 面：列出、检测、在指定机器上开终端。
//!
//! 机器数据只读：增删改仍只在 UI 里做（凭据要走钥匙串，不经 MCP 传明文）。
use super::*;
use cc_panes_core::models::ssh_machine::SshMachine;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpCheckSshMachineParams {
    /// 机器 ID（list_ssh_machines 返回的 id）
    #[serde(rename = "machineId")]
    pub(super) machine_id: String,
}

/// 给 AI 看的机器摘要：不含任何凭据。
pub(super) fn ssh_machine_summary(machine: &SshMachine) -> serde_json::Value {
    serde_json::json!({
        "id": machine.id,
        "name": machine.name,
        "host": machine.host,
        "port": machine.port,
        "user": machine.user,
        "authMethod": machine.auth_method,
        "tags": machine.tags,
        "description": machine.description,
        "defaultPath": machine.default_path,
        "routed": machine.uses_routed_connection(),
    })
}

/// 与前端 `buildTerminalOpts` 同口径的 SSH 连接信息与项目路径（`ssh://user@host:port/path`）。
pub(super) fn machine_terminal_target(
    machine: &SshMachine,
    remote_path: &str,
) -> (String, SshConnectionInfo) {
    let user_part = machine
        .user
        .as_deref()
        .map(|user| format!("{user}@"))
        .unwrap_or_default();
    let port_part = if machine.port == 22 {
        String::new()
    } else {
        format!(":{}", machine.port)
    };
    let path = format!("ssh://{user_part}{}{port_part}/{remote_path}", machine.host);
    let info = SshConnectionInfo {
        host: machine.host.clone(),
        port: machine.port,
        user: machine.user.clone(),
        remote_path: remote_path.to_string(),
        identity_file: machine.identity_file.clone(),
        machine_id: Some(machine.id.clone()),
        auth_method: Some(machine.auth_method.clone()),
    };
    (path, info)
}

/// `machineId` 指定时的运行时：直接用这台机器，不看工作空间的运行环境配置。
pub(super) fn machine_runtime(
    machine: &SshMachine,
    requested_cwd: Option<&str>,
) -> (String, ResolvedLaunchRuntime) {
    let remote_path = requested_cwd
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .or(machine
            .default_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty()))
        .unwrap_or("~");
    let (project_path, ssh) = machine_terminal_target(machine, remote_path);
    (
        project_path,
        ResolvedLaunchRuntime {
            kind: LaunchRuntimeKind::Ssh,
            source: "machine",
            notice: None,
            wsl: None,
            ssh: Some(ssh),
        },
    )
}

impl McpToolHandler {
    pub(super) fn list_ssh_machines_impl(&self) -> String {
        let machines: Vec<serde_json::Value> = self
            .state
            .ssh_machine_service
            .list()
            .iter()
            .map(ssh_machine_summary)
            .collect();
        serde_json::json!({ "machines": machines }).to_string()
    }

    pub(super) async fn check_ssh_machine_impl(&self, params: McpCheckSshMachineParams) -> String {
        let machine_id = params.machine_id.trim().to_string();
        let Some(machine) = self.state.ssh_machine_service.get(&machine_id) else {
            return format!(
                "错误: 找不到 SSH 机器 '{}'（先用 list_ssh_machines 查 id）",
                machine_id
            );
        };
        info!(machine_id = %machine_id, "mcp::check_ssh_machine");
        match self
            .state
            .ssh_machine_service
            .check_connectivity(&machine_id)
            .await
        {
            Ok(result) => serde_json::json!({
                "machineId": machine.id,
                "name": machine.name,
                "reachable": result.reachable,
                "message": result.message,
                "latencyMs": result.latency_ms,
                "os": result.os,
                "ccPanes": result.cc_panes,
                "canDeploy": result.cc_panes.is_none()
                    && matches!(result.os.as_deref(), Some("linux" | "macos")),
            })
            .to_string(),
            Err(error) => format!("错误: 检测失败: {error:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::models::ssh_machine::AuthMethod;

    fn machine(port: u16, user: Option<&str>, default_path: Option<&str>) -> SshMachine {
        SshMachine {
            id: "m1".into(),
            name: "box".into(),
            host: "192.168.2.9".into(),
            port,
            user: user.map(str::to_string),
            auth_method: AuthMethod::Key,
            identity_file: Some("~/.ssh/id_rsa".into()),
            description: None,
            default_path: default_path.map(str::to_string),
            tags: vec!["gpu".into()],
            proxy: None,
            jump_host: None,
            has_stored_password: true,
            has_stored_proxy_password: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn terminal_target_matches_frontend_path_shape() {
        let (path, info) = machine_terminal_target(&machine(22, Some("a"), None), "~");
        assert_eq!(path, "ssh://a@192.168.2.9/~");
        assert_eq!(info.machine_id.as_deref(), Some("m1"));
        let (path, _) = machine_terminal_target(&machine(2222, None, None), "/srv");
        assert_eq!(path, "ssh://192.168.2.9:2222//srv");
    }

    #[test]
    fn runtime_prefers_cwd_then_default_path_then_home() {
        let m = machine(22, Some("a"), Some("~/work"));
        let (_, rt) = machine_runtime(&m, Some("/opt"));
        assert_eq!(rt.ssh.unwrap().remote_path, "/opt");
        let (_, rt) = machine_runtime(&m, None);
        assert_eq!(rt.ssh.unwrap().remote_path, "~/work");
        let (_, rt) = machine_runtime(&machine(22, None, None), Some("  "));
        assert_eq!(rt.ssh.unwrap().remote_path, "~");
        assert_eq!(rt.kind, LaunchRuntimeKind::Ssh);
    }

    #[test]
    fn summary_has_no_credentials() {
        let json = ssh_machine_summary(&machine(22, Some("a"), None)).to_string();
        assert!(!json.contains("hasStoredPassword"));
        assert!(!json.contains("password"));
    }
}
