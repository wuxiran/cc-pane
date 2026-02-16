use crate::models::{TerminalExit, TerminalOutput};
use crate::services::{NotificationService, ProviderService, SettingsService};
use crate::utils::AppPaths;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// 找到一个空闲的 TCP 端口用于 IPC 通信
fn find_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(19836) // 回退到默认值
}

/// 解析 cc-panes-tui 二进制路径
/// 优先在当前可执行文件同目录查找，回退到 PATH
fn resolve_tui_binary() -> String {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let tui_path = exe_dir.join("cc-panes-tui.exe");
            if tui_path.exists() {
                return tui_path.to_string_lossy().to_string();
            }
            // 非 Windows 场景
            let tui_path = exe_dir.join("cc-panes-tui");
            if tui_path.exists() {
                return tui_path.to_string_lossy().to_string();
            }
        }
    }
    // 回退到 PATH 查找
    "cc-panes-tui".to_string()
}

/// 终端状态
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Active,
    Idle,
    WaitingInput,
    Exited,
}

/// 终端会话状态信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusInfo {
    pub session_id: String,
    pub status: SessionStatus,
    pub last_output_at: u64, // 毫秒时间戳
}

/// 终端会话
struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    status: Arc<Mutex<SessionStatus>>,
    last_output_at: Arc<Mutex<Instant>>,
}

/// 终端服务 - 管理多个 PTY 会话
pub struct TerminalService {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    settings_service: Arc<SettingsService>,
    provider_service: Arc<ProviderService>,
    notification_service: Arc<NotificationService>,
    app_paths: Arc<AppPaths>,
}

impl TerminalService {
    pub fn new(
        settings_service: Arc<SettingsService>,
        provider_service: Arc<ProviderService>,
        notification_service: Arc<NotificationService>,
        app_paths: Arc<AppPaths>,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            settings_service,
            provider_service,
            notification_service,
            app_paths,
        }
    }

    /// 创建新的终端会话
    pub fn create_session(
        &self,
        app_handle: AppHandle,
        project_path: &str,
        cols: u16,
        rows: u16,
        workspace_name: Option<&str>,
        provider_id: Option<&str>,
    ) -> Result<String> {
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        let provider_vars = self.provider_service.get_env_vars(provider_id);
        env_vars.extend(provider_vars);
        let workspaces_dir = self.app_paths.workspaces_dir();
        let notification_service = self.notification_service.clone();
        let settings_service = self.settings_service.clone();
        let session_id = Uuid::new_v4().to_string();

        // 创建 PTY
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // 辅助函数：注入环境变量
        let inject_env = |cmd: &mut CommandBuilder, env_vars: &HashMap<String, String>| {
            #[cfg(windows)]
            {
                cmd.env("TERM", "xterm-256color");
            }
            for (key, value) in env_vars {
                cmd.env(key, value);
            }
        };

        // 根据 workspace_name 决定启动方式
        let mut cmd = if let Some(ws_name) = workspace_name {
            let ws_dir = workspaces_dir.join(ws_name);
            let ws_json = ws_dir.join("workspace.json");
            if ws_json.exists() {
                let port = find_free_port();
                let mut cmd = CommandBuilder::new(resolve_tui_binary());
                cmd.arg("run");
                cmd.arg("--workspace-dir");
                cmd.arg(ws_dir.to_string_lossy().to_string());
                cmd.arg("--port");
                cmd.arg(port.to_string());
                cmd.cwd(project_path);
                cmd
            } else {
                let mut cmd = CommandBuilder::new_default_prog();
                cmd.cwd(project_path);
                cmd
            }
        } else {
            let mut cmd = CommandBuilder::new_default_prog();
            cmd.cwd(project_path);
            cmd
        };

        inject_env(&mut cmd, &env_vars);

        // 启动子进程
        let mut child = pair.slave.spawn_command(cmd)?;

        // 获取 master 的读写端
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // 状态追踪
        let status = Arc::new(Mutex::new(SessionStatus::Active));
        let last_output_at = Arc::new(Mutex::new(Instant::now()));

        // 保存会话
        {
            let mut sessions = self.sessions.lock().map_err(|_| anyhow!("sessions 锁被污染"))?;
            sessions.insert(
                session_id.clone(),
                TerminalSession {
                    master: pair.master,
                    writer,
                    status: status.clone(),
                    last_output_at: last_output_at.clone(),
                },
            );
        }

        // 启动读取线程（含状态检测）
        let sid = session_id.clone();
        let handle = app_handle.clone();
        let read_status = status.clone();
        let read_last_output = last_output_at.clone();
        let notif_svc = notification_service.clone();
        let settings_svc = settings_service.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let prev_status = Mutex::new(SessionStatus::Active);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();

                        // 更新状态
                        {
                            let mut ts = read_last_output.lock().unwrap();
                            *ts = Instant::now();
                        }

                        // 推断状态
                        let new_status = infer_status(&data);
                        {
                            let mut s = read_status.lock().unwrap();
                            *s = new_status;
                        }

                        // 检测状态变更并触发通知
                        {
                            let mut prev = prev_status.lock().unwrap();
                            if *prev != SessionStatus::WaitingInput
                                && new_status == SessionStatus::WaitingInput
                            {
                                notif_svc.notify_waiting_input(&handle, &settings_svc, &sid);
                            }
                            *prev = new_status;
                        }

                        // 发送输出事件
                        let _ = handle.emit(
                            "terminal-output",
                            TerminalOutput {
                                session_id: sid.clone(),
                                data,
                            },
                        );

                        // 发送状态事件
                        let _ = handle.emit(
                            "terminal-status",
                            SessionStatusInfo {
                                session_id: sid.clone(),
                                status: new_status,
                                last_output_at: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64,
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!("Terminal read error: {}", e);
                        break;
                    }
                }
            }
        });

        // 启动等待线程
        let sid = session_id.clone();
        let handle = app_handle;
        let exit_status = status;
        let notif_svc_exit = notification_service;
        let settings_svc_exit = settings_service;
        thread::spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => {
                    if status.success() { 0 } else { 1 }
                }
                Err(_) => -1,
            };

            // 标记为已退出
            {
                let mut s = exit_status.lock().unwrap();
                *s = SessionStatus::Exited;
            }

            // 发送退出通知
            notif_svc_exit.notify_session_exited(&handle, &settings_svc_exit, &sid, exit_code);
            notif_svc_exit.cleanup_session(&sid);

            let _ = handle.emit(
                "terminal-exit",
                TerminalExit {
                    session_id: sid.clone(),
                    exit_code,
                },
            );

            // 发送最终状态
            let _ = handle.emit(
                "terminal-status",
                SessionStatusInfo {
                    session_id: sid,
                    status: SessionStatus::Exited,
                    last_output_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                },
            );
        });

        Ok(session_id)
    }

    /// 获取所有会话状态
    pub fn get_all_status(&self) -> Result<Vec<SessionStatusInfo>> {
        let sessions = self.sessions.lock().map_err(|_| anyhow!("sessions 锁被污染"))?;
        Ok(sessions
            .iter()
            .map(|(id, session)| {
                let status = *session.status.lock().unwrap_or_else(|e| e.into_inner());
                let elapsed = session.last_output_at.lock().unwrap_or_else(|e| e.into_inner()).elapsed();

                // 基于时间的状态修正
                let adjusted_status = match status {
                    SessionStatus::Active if elapsed.as_secs() > 30 => SessionStatus::Idle,
                    other => other,
                };

                SessionStatusInfo {
                    session_id: id.clone(),
                    status: adjusted_status,
                    last_output_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                        - elapsed.as_millis() as u64,
                }
            })
            .collect())
    }

    /// 向终端写入数据
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|_| anyhow!("sessions 锁被污染"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Session not found: {}", session_id))?;

        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    /// 调整终端大小
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().map_err(|_| anyhow!("sessions 锁被污染"))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session not found: {}", session_id))?;

        session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// 关闭终端会话
    pub fn kill(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|_| anyhow!("sessions 锁被污染"))?;
        if sessions.remove(session_id).is_some() {
            // 会话被删除，资源会自动清理
            Ok(())
        } else {
            Err(anyhow!("Session not found: {}", session_id))
        }
    }
}


/// 从输出内容推断终端状态
fn infer_status(output: &str) -> SessionStatus {
    let trimmed = output.trim();

    if let Some(last_line) = trimmed.lines().last() {
        let line = last_line.trim();

        // Claude Code 权限提示：Yes/No 确认
        if line.ends_with("[Y/n]") || line.ends_with("[y/N]") {
            return SessionStatus::WaitingInput;
        }

        // Claude Code 提问：以 "?" 结尾
        if line.ends_with('?') {
            return SessionStatus::WaitingInput;
        }

        // 检测 shell prompt 特征（等待输入）
        let prompt_patterns = ["$ ", "# ", "> ", "❯ ", "λ ", "PS>", ">>> ", "... "];
        for pattern in &prompt_patterns {
            if line.ends_with(pattern) || line.ends_with(pattern.trim()) {
                return SessionStatus::WaitingInput;
            }
        }
    }

    // 默认为活跃
    SessionStatus::Active
}
