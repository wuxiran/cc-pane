use std::sync::Arc;

use crate::models::{CreateSessionRequest, TerminalReplaySnapshot};
use crate::services::daemon_client::TerminalDaemonClient;
use crate::services::terminal_service::KillReason;
use crate::services::terminal_service::SessionOutput;
use crate::services::terminal_service::SessionStatus;
use crate::services::terminal_service::TerminalService;
use crate::services::SessionStatusInfo;
use crate::utils::error::AppError;
use crate::utils::AppResult;

/// Backend boundary for terminal session operations.
///
/// The default implementation delegates to the in-process `TerminalService`.
/// Future daemon support should implement this trait without changing the
/// Tauri IPC command contract.
pub trait TerminalBackend: Send + Sync {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String>;
    fn write(&self, session_id: &str, data: &str) -> AppResult<()>;
    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()>;
    /// Returns whether the terminal has enabled DEC private mode 2004.
    /// Backends without a readiness bridge return false.
    fn is_paste_ready(&self, _session_id: &str) -> AppResult<bool> {
        Ok(false)
    }
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()>;
    fn kill(&self, session_id: &str) -> AppResult<()>;
    /// 带来源的 kill。默认委托 `kill`（reason 丢失），真实后端覆盖之以便
    /// `session-killed` 事件携带来源、前端分流关标签/保留标签。
    fn kill_with_reason(&self, session_id: &str, _reason: KillReason) -> AppResult<()> {
        self.kill(session_id)
    }
    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>>;
    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>>;
    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput>;
    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>>;
    /// 按 launch_id 反查会话 id（launch_task 推导 parent_session_id 用）。
    /// daemon 模式下会话建在 daemon 进程，必须走 backend 而非 app 本地 service。
    /// 默认返回 `None`（不支持反查的后端，如测试 mock）；真实后端覆盖之。
    fn find_session_id_by_launch_id(&self, _launch_id: &str) -> AppResult<Option<String>> {
        Ok(None)
    }
    /// 把 hook 状态机决定的新 status 写回会话（更新 status Mutex + emit）。
    /// daemon 模式下会话在 daemon，写回必须打到 daemon，否则前端桥接轮询看不到细分状态。
    /// 默认 no-op；真实后端覆盖之。
    fn apply_hook_status(&self, _session_id: &str, _status: SessionStatus) -> AppResult<()> {
        Ok(())
    }
    fn event_stream_url(&self, _session_id: &str) -> Option<String> {
        None
    }
}

#[derive(Clone)]
pub struct InProcessTerminalBackend {
    service: Arc<TerminalService>,
}

/// 续租间隔：取 daemon 侧 TTL(30s) 的三分之一，容忍两次连续失败仍不掉租。
const CLAIM_RENEW_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone)]
pub struct DaemonTerminalBackend {
    client: TerminalDaemonClient,
    /// 本实例持有写权限的会话集合（docs/61 阶段 2）。
    /// 由创建者写入，续租线程按此表定期续约；丢租时移除并告警。
    ///
    /// 续租线程只持 `Weak`：本类型是 `Clone` 的，用 `Drop` 停线程会让任意一个克隆
    /// 析构就掐掉所有实例的续租。改成最后一个 backend 释放时 upgrade 失败自然退出。
    owned_sessions: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl InProcessTerminalBackend {
    pub fn new(service: Arc<TerminalService>) -> Self {
        Self { service }
    }
}

impl DaemonTerminalBackend {
    pub fn new(client: TerminalDaemonClient) -> Self {
        let owned_sessions: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
            Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        // 续租线程：租约是 TTL 制，不续就会过期，别的实例便可接手。
        // 单独起线程而不是挂在请求路径上——用户长时间不操作的会话同样要保住写权限。
        {
            let client = client.clone();
            let owned = Arc::downgrade(&owned_sessions);
            std::thread::Builder::new()
                .name("cc-panes-claim-renew".to_string())
                .spawn(move || {
                    loop {
                        std::thread::sleep(CLAIM_RENEW_INTERVAL);
                        // 所有 backend 都已释放 → 退出，不再续租。
                        let Some(owned) = owned.upgrade() else { break };
                        let sessions: Vec<String> = match owned.lock() {
                            Ok(guard) => guard.iter().cloned().collect(),
                            Err(_) => continue,
                        };
                        for session_id in sessions {
                            match client.claim_session(&session_id, None) {
                                Ok(true) => {}
                                Ok(false) => {
                                    // 被别的实例接手了（通常是本实例曾长时间失联）。
                                    // 不重试抢占：两个实例交替抢租约会让输入交错。
                                    tracing::warn!(
                                        session_id = %session_id,
                                        "lost session write claim to another instance"
                                    );
                                    if let Ok(mut guard) = owned.lock() {
                                        guard.remove(&session_id);
                                    }
                                }
                                Err(error) => {
                                    tracing::debug!(
                                        session_id = %session_id,
                                        err = %error,
                                        "claim renew failed; will retry next tick"
                                    );
                                }
                            }
                        }
                    }
                })
                .ok();
        }

        Self {
            client,
            owned_sessions,
        }
    }

    /// 接管一条已存在的会话：拿到写权限才算接管成功。
    /// 被别的实例持有时返回 `false`，调用方应保持只读，不要抢。
    pub fn adopt_session(&self, session_id: &str) -> AppResult<bool> {
        let granted = self.client.claim_session(session_id, None)?;
        if granted {
            if let Ok(mut owned) = self.owned_sessions.lock() {
                owned.insert(session_id.to_string());
            }
        }
        Ok(granted)
    }

    /// 主动放弃写权限（detach 但不 kill PTY）——评审要求的回退路径。
    pub fn release_session(&self, session_id: &str) -> AppResult<()> {
        self.forget_owned(session_id);
        self.client.release_session_claim(session_id)
    }

    pub fn session_claims(&self) -> AppResult<std::collections::HashMap<String, String>> {
        self.client.list_session_claims()
    }

    fn forget_owned(&self, session_id: &str) {
        if let Ok(mut owned) = self.owned_sessions.lock() {
            owned.remove(session_id);
        }
    }
}

impl TerminalBackend for TerminalService {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        TerminalService::create_session(
            self,
            request.launch_id.as_deref(),
            &request.project_path,
            request.cols,
            request.rows,
            request.workspace_name.as_deref(),
            request.provider_id.as_deref(),
            request.provider_selection,
            request.launch_profile_id.as_deref(),
            request.workspace_path.as_deref(),
            request.workspace_snapshot_id.as_deref(),
            request.effective_cli_tool(),
            request.resume_id.as_deref(),
            request.skip_mcp,
            request.append_system_prompt.as_deref(),
            request.initial_prompt.as_deref(),
            request.yolo_mode,
            request.adapter_options.as_ref(),
            request.extra_env.as_ref(),
            request.ssh.as_ref(),
            request.wsl.as_ref(),
        )
        .map_err(|error| {
            error
                .downcast_ref::<AppError>()
                .cloned()
                .unwrap_or_else(|| AppError::from(error))
        })
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        TerminalService::write(self, session_id, data).map_err(AppError::from)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        TerminalService::submit_text_to_session(self, session_id, text)
    }

    fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        TerminalService::is_paste_ready(self, session_id)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        TerminalService::resize(self, session_id, cols, rows).map_err(AppError::from)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        TerminalService::kill(self, session_id)
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        TerminalService::kill_with_reason(self, session_id, reason)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        TerminalService::get_all_status(self).map_err(AppError::from)
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        TerminalService::get_session_status(self, session_id).map_err(AppError::from)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        TerminalService::get_session_output(self, session_id, lines).map_err(AppError::from)
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        TerminalService::get_session_replay_snapshot(self, session_id).map_err(AppError::from)
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        Ok(TerminalService::find_session_id_by_launch_id(
            self, launch_id,
        ))
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        TerminalService::apply_hook_status(self, session_id, status);
        Ok(())
    }
}

impl TerminalBackend for InProcessTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        <TerminalService as TerminalBackend>::create_session(self.service.as_ref(), request)
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::write(self.service.as_ref(), session_id, data)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::submit_text_to_session(
            self.service.as_ref(),
            session_id,
            text,
        )
    }

    fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        <TerminalService as TerminalBackend>::is_paste_ready(self.service.as_ref(), session_id)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        <TerminalService as TerminalBackend>::resize(self.service.as_ref(), session_id, cols, rows)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::kill(self.service.as_ref(), session_id)
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        <TerminalService as TerminalBackend>::kill_with_reason(
            self.service.as_ref(),
            session_id,
            reason,
        )
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        <TerminalService as TerminalBackend>::get_all_status(self.service.as_ref())
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        <TerminalService as TerminalBackend>::get_session_status(self.service.as_ref(), session_id)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        <TerminalService as TerminalBackend>::get_session_output(
            self.service.as_ref(),
            session_id,
            lines,
        )
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        <TerminalService as TerminalBackend>::get_session_replay_snapshot(
            self.service.as_ref(),
            session_id,
        )
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        <TerminalService as TerminalBackend>::find_session_id_by_launch_id(
            self.service.as_ref(),
            launch_id,
        )
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        <TerminalService as TerminalBackend>::apply_hook_status(
            self.service.as_ref(),
            session_id,
            status,
        )
    }
}

impl TerminalBackend for DaemonTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        let session_id = self.client.create_session(request)?;
        // 创建者即所有者：立刻 claim，之后由续租线程保活。
        // claim 失败不影响会话可用性（daemon 无租约时放行），所以只告警不回滚。
        match self.client.claim_session(&session_id, None) {
            Ok(true) => {
                if let Ok(mut owned) = self.owned_sessions.lock() {
                    owned.insert(session_id.clone());
                }
            }
            Ok(false) => tracing::warn!(
                session_id = %session_id,
                "newly created session is already claimed by another instance"
            ),
            Err(error) => tracing::warn!(
                session_id = %session_id,
                err = %error,
                "failed to claim newly created session"
            ),
        }
        Ok(session_id)
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.client.write_session(session_id, data)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.client.submit_text_to_session(session_id, text)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.client.resize_session(session_id, cols, rows)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        self.forget_owned(session_id);
        self.client.kill_session(session_id)
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        self.client.kill_session_with_reason(session_id, reason)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        self.client.list_sessions()
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        self.client.get_session_status(session_id)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        self.client.get_session_output(session_id, lines)
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        self.client.get_session_replay_snapshot(session_id)
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        self.client.find_session_id_by_launch_id(launch_id)
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        self.client.apply_hook_status(session_id, status)
    }

    fn event_stream_url(&self, session_id: &str) -> Option<String> {
        Some(self.client.websocket_url(session_id))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use crate::models::{CliTool, TerminalBufferMode};
    use crate::services::terminal_service::SessionStatus;

    use super::*;

    fn http_json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn spawn_response_server(response: String) -> (SocketAddr, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            let mut request_bytes = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let n = stream.read(&mut chunk).expect("read request");
                if n == 0 {
                    break;
                }
                request_bytes.extend_from_slice(&chunk[..n]);
                if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request_bytes).expect("utf8 request");
            tx.send(request).ok();
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        (addr, rx)
    }

    fn backend_for(addr: SocketAddr) -> DaemonTerminalBackend {
        DaemonTerminalBackend::new(
            TerminalDaemonClient::new(addr.to_string(), "secret")
                .with_timeout(Duration::from_secs(1)),
        )
    }

    fn create_request() -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: None,
            project_path: "/repo".to_string(),
            cols: 120,
            rows: 30,
            workspace_name: None,
            provider_id: None,
            provider_selection: Default::default(),
            launch_profile_id: None,
            workspace_path: None,
            workspace_snapshot_id: None,
            launch_claude: false,
            cli_tool: CliTool::None,
            resume_id: None,
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            yolo_mode: None,
            adapter_options: None,
            extra_env: Some(std::collections::HashMap::from([(
                "RUNNER_ENV".to_string(),
                "1".to_string(),
            )])),
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn daemon_backend_maps_terminal_operations_to_client() {
        let (addr, rx) =
            spawn_response_server(http_json_response("201 Created", r#"{"sessionId":"s1"}"#));
        let backend = backend_for(addr);

        let session_id = backend.create_session(create_request()).expect("create");

        assert_eq!(session_id, "s1");
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions HTTP/1.1"));
        assert!(request.contains(r#""extraEnv":{"RUNNER_ENV":"1"}"#));

        let (addr, rx) = spawn_response_server(
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_string(),
        );
        let backend = backend_for(addr);

        backend.write("s1", "abc").expect("write");

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/s1/write HTTP/1.1"));
    }

    #[test]
    fn daemon_backend_maps_status_output_and_snapshot_payloads() {
        let status_body = r#"[{"sessionId":"s1","status":"exited","lastOutputAt":10,"pid":42,"exitCode":7,"updatedAt":20}]"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", status_body));
        let backend = backend_for(addr);

        let statuses = backend.get_all_status().expect("statuses");

        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, SessionStatus::Exited);
        assert_eq!(statuses[0].exit_code, Some(7));

        let output_body = r#"{"sessionId":"s1","lines":["ready"]}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", output_body));
        let backend = backend_for(addr);

        let output = backend.get_session_output("s1", 20).expect("output");

        assert_eq!(output.session_id, "s1");
        assert_eq!(output.lines, vec!["ready"]);

        let snapshot_body = r#"{"data":"\u001b[2J","bufferMode":"normal"}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", snapshot_body));
        let backend = backend_for(addr);

        let snapshot = backend
            .get_session_replay_snapshot("s1")
            .expect("snapshot")
            .expect("some snapshot");

        assert_eq!(snapshot.buffer_mode, TerminalBufferMode::Normal);
    }

    #[test]
    fn daemon_backend_maps_missing_snapshot_to_none() {
        let (addr, _) = spawn_response_server(http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
        ));
        let backend = backend_for(addr);

        let snapshot = backend
            .get_session_replay_snapshot("missing")
            .expect("result");

        assert!(snapshot.is_none());
    }
}
