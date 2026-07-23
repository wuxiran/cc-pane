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

#[derive(Clone)]
pub struct DaemonTerminalBackend {
    client: TerminalDaemonClient,
}

impl InProcessTerminalBackend {
    pub fn new(service: Arc<TerminalService>) -> Self {
        Self { service }
    }
}

impl DaemonTerminalBackend {
    pub fn new(client: TerminalDaemonClient) -> Self {
        Self { client }
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
        self.client.create_session(request)
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
