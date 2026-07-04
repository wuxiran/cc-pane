//! ccchan mascot backend service.
//!
//! Sprite attribution: Homie spritesheet from oc-claw (MIT), Copyright (c) rainnoon.

use crate::models::settings::CCChanSettings;
use crate::models::{CliTool, LaunchProviderSelection};
use crate::services::{ProviderService, SettingsService, TerminalService};
use crate::utils::{AppError, AppPaths, AppResult};
use cc_cli_adapters::{
    no_window_command, ClaudeAdapter, CliAdapterContext, CliProvider, CliToolAdapter, CodexAdapter,
};
use cc_panes_core::events::SessionNotifier;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tracing::{debug, info, warn};
use uuid::Uuid;

const CCCHAN_WINDOW_LABEL: &str = "ccchan";
const CCCHAN_EVENT: &str = "ccchan-event";
const CCCHAN_CHAT_OUTPUT_EVENT: &str = "ccchan-chat-output";
const CCCHAN_CHAT_STATUS_EVENT: &str = "ccchan-chat-status";
const CCCHAN_HELPER_PROMPT: &str =
    include_str!("../../resources/claude-bundle/default-skills/ccchan-helper.md");

#[derive(Debug, Clone)]
enum ChatSessionState {
    Terminal {
        session_id: String,
    },
    ClaudeStructured {
        session_id: String,
        chat_dir: PathBuf,
        claude_session_id: Option<String>,
        provider_id: Option<String>,
    },
    CodexStructured {
        session_id: String,
        chat_dir: PathBuf,
        codex_thread_id: Option<String>,
        provider_id: Option<String>,
    },
}

impl ChatSessionState {
    fn session_id(&self) -> &str {
        match self {
            Self::Terminal { session_id }
            | Self::ClaudeStructured { session_id, .. }
            | Self::CodexStructured { session_id, .. } => session_id,
        }
    }
}

#[derive(Debug, Clone)]
struct ClaudeCommandSpec {
    command: String,
    args: Vec<String>,
    env_remove: Vec<String>,
}

#[derive(Debug, Clone)]
struct CodexCommandSpec {
    command: String,
    args: Vec<String>,
    env_remove: Vec<String>,
    env_inject: HashMap<String, String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedClaudeLine {
    text: Option<String>,
    status: Option<&'static str>,
    session_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedCodexLine {
    text: Option<String>,
    status: Option<&'static str>,
    thread_id: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CCChanChatOutputPayload<'a> {
    session_id: &'a str,
    role: &'a str,
    text: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CCChanChatStatusPayload<'a> {
    session_id: &'a str,
    status: &'a str,
    message: Option<&'a str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetMeta {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_url: String,
    pub atlas: PetAtlas,
    pub animations: HashMap<String, PetAnimation>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAtlas {
    pub cell_w: u32,
    pub cell_h: u32,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAnimation {
    pub row: u32,
    pub frames: u32,
    pub fps: u32,
    #[serde(default)]
    pub col_offset: u32,
}

#[derive(Deserialize)]
struct PetsManifest {
    pets: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetDefinition {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
    atlas: PetAtlas,
    animations: HashMap<String, PetAnimation>,
}

pub struct CCChanService {
    settings_service: Arc<SettingsService>,
    provider_service: Arc<ProviderService>,
    app_paths: Arc<AppPaths>,
    app_handle: Mutex<Option<AppHandle>>,
    chat_session: Mutex<Option<ChatSessionState>>,
}

impl CCChanService {
    pub fn new(
        settings_service: Arc<SettingsService>,
        provider_service: Arc<ProviderService>,
        app_paths: Arc<AppPaths>,
    ) -> Self {
        Self {
            settings_service,
            provider_service,
            app_paths,
            app_handle: Mutex::new(None),
            chat_session: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app_handle);
        }
    }

    pub fn settings(&self) -> CCChanSettings {
        self.settings_service.get_settings().ccchan
    }

    pub fn save_settings(&self, settings: CCChanSettings) -> AppResult<()> {
        let mut app_settings = self.settings_service.get_settings();
        app_settings.ccchan = settings;
        self.settings_service.update_settings(app_settings)?;
        Ok(())
    }

    pub fn show_window(&self, app: &AppHandle) -> AppResult<()> {
        let window = ccchan_window(app)?;
        window
            .set_size(LogicalSize::new(120.0, 120.0))
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_decorations(false)
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_always_on_top(true)
            .map_err(|error| AppError::from(error.to_string()))?;
        position_window(&window, &self.settings())?;
        window
            .show()
            .map_err(|error| AppError::from(error.to_string()))?;
        Ok(())
    }

    pub fn hide_window(&self, app: &AppHandle) -> AppResult<()> {
        let window = ccchan_window(app)?;
        window
            .hide()
            .map_err(|error| AppError::from(error.to_string()))?;
        Ok(())
    }

    pub fn save_window_position(&self, x: f64, y: f64) -> AppResult<()> {
        let mut settings = self.settings();
        settings.window_x = Some(x);
        settings.window_y = Some(y);
        self.save_settings(settings)
    }

    pub fn get_pets(&self, app: &AppHandle) -> AppResult<Vec<PetMeta>> {
        let root = resolve_ccchan_root(app)?;
        let manifest_path = root.join("pets-manifest.json");
        let manifest_content = std::fs::read_to_string(&manifest_path).map_err(|error| {
            AppError::from(format!(
                "Failed to read {}: {}",
                manifest_path.display(),
                error
            ))
        })?;
        let manifest: PetsManifest = serde_json::from_str(&manifest_content)
            .map_err(|error| AppError::from(format!("Invalid pets manifest: {error}")))?;

        manifest
            .pets
            .iter()
            .map(|pet_id| self.load_pet(&root, pet_id))
            .collect()
    }

    pub fn start_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        ai_engine: String,
    ) -> AppResult<String> {
        let cli_tool = parse_ai_engine(&ai_engine)?;
        let chat_dir = self.app_paths.data_dir().join("ccchan");
        info!(
            ai_engine = %ai_engine,
            cli_tool = ?cli_tool,
            chat_dir = %chat_dir.display(),
            "ccchan chat start requested"
        );
        std::fs::create_dir_all(&chat_dir).map_err(|error| {
            AppError::from(format!(
                "Failed to create ccchan chat directory {}: {}",
                chat_dir.display(),
                error
            ))
        })?;

        if let Some(existing) = self.take_chat_session()? {
            self.stop_existing_chat_for_replacement(terminal_service.clone(), existing);
        }

        if cli_tool == CliTool::Claude {
            return self.start_structured_claude_chat(chat_dir);
        }
        if cli_tool == CliTool::Codex {
            return self.start_structured_codex_chat(chat_dir);
        }

        let chat_dir_str = chat_dir.to_string_lossy().to_string();
        let default_provider_id = self
            .provider_service
            .get_default_provider()
            .map(|provider| provider.id);
        let provider_selection = if default_provider_id.is_some() {
            LaunchProviderSelection::Explicit
        } else {
            LaunchProviderSelection::None
        };
        let session_id = terminal_service.create_session(
            None,
            &chat_dir_str,
            120,
            32,
            None,
            default_provider_id.as_deref(),
            provider_selection,
            None,
            None,
            None,
            cli_tool,
            None,
            true,
            Some(CCCHAN_HELPER_PROMPT),
            None,
            None,
            None,
            None,
        )?;
        info!(
            session_id = %session_id,
            ai_engine = %ai_engine,
            cli_tool = ?cli_tool,
            provider_id = default_provider_id.as_deref().unwrap_or("none"),
            "ccchan chat session created"
        );

        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        *stored = Some(ChatSessionState::Terminal {
            session_id: session_id.clone(),
        });
        Ok(session_id)
    }

    pub fn send_to_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        session_id: &str,
        text: &str,
    ) -> AppResult<()> {
        debug!(session_id, text_len = text.len(), "ccchan chat send input");
        let session = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?
            .clone();
        match session {
            Some(ChatSessionState::Terminal {
                session_id: stored_id,
            }) if stored_id == session_id => {
                terminal_service.write(session_id, text)?;
                terminal_service.write(session_id, "\r")?;
                Ok(())
            }
            Some(ChatSessionState::ClaudeStructured {
                session_id: stored_id,
                chat_dir,
                claude_session_id,
                provider_id,
            }) if stored_id == session_id => {
                let next_claude_session_id = self.run_structured_claude_turn(
                    session_id,
                    &chat_dir,
                    claude_session_id.as_deref(),
                    provider_id.as_deref(),
                    text,
                )?;
                if let Some(next_id) = next_claude_session_id {
                    self.update_structured_claude_session_id(session_id, next_id)?;
                }
                Ok(())
            }
            Some(ChatSessionState::CodexStructured {
                session_id: stored_id,
                chat_dir,
                codex_thread_id,
                provider_id,
            }) if stored_id == session_id => {
                let next_codex_thread_id = self.run_structured_codex_turn(
                    session_id,
                    &chat_dir,
                    codex_thread_id.as_deref(),
                    provider_id.as_deref(),
                    text,
                )?;
                if let Some(next_id) = next_codex_thread_id {
                    self.update_structured_codex_thread_id(session_id, next_id)?;
                }
                Ok(())
            }
            _ => Err(AppError::from(format!(
                "ccchan chat session '{session_id}' is not active"
            ))),
        }
    }

    pub fn stop_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        session_id: &str,
    ) -> AppResult<()> {
        info!(session_id, "ccchan chat stop requested");
        let session = self.clear_chat_session(session_id)?;
        match session {
            Some(ChatSessionState::Terminal { .. }) | None => {
                match terminal_service.kill(session_id) {
                    Ok(()) => {
                        info!(session_id, "ccchan chat stopped");
                        Ok(())
                    }
                    Err(error) if error.to_string().to_ascii_lowercase().contains("not found") => {
                        info!(
                            session_id,
                            "ccchan chat stop ignored because session is gone"
                        );
                        Ok(())
                    }
                    Err(error) => Err(AppError::from(error.to_string())),
                }
            }
            Some(ChatSessionState::ClaudeStructured { .. }) => {
                self.emit_chat_status(
                    session_id,
                    "exited",
                    Some("Claude CLI chat 已停止。点“重启 CLI”重新连接。"),
                );
                info!(session_id, "ccchan structured chat stopped");
                Ok(())
            }
            Some(ChatSessionState::CodexStructured { .. }) => {
                self.emit_chat_status(
                    session_id,
                    "exited",
                    Some("Codex CLI chat 已停止。点“重启 CLI”重新连接。"),
                );
                info!(session_id, "ccchan structured Codex chat stopped");
                Ok(())
            }
        }
    }

    pub fn is_chat_session_alive(
        &self,
        terminal_service: Arc<TerminalService>,
        session_id: &str,
    ) -> AppResult<bool> {
        let session = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?
            .clone();
        match session {
            Some(ChatSessionState::ClaudeStructured {
                session_id: stored_id,
                ..
            }) if stored_id == session_id => Ok(true),
            Some(ChatSessionState::CodexStructured {
                session_id: stored_id,
                ..
            }) if stored_id == session_id => Ok(true),
            Some(ChatSessionState::Terminal {
                session_id: stored_id,
            }) if stored_id == session_id => Ok(terminal_service
                .get_all_status()?
                .iter()
                .any(|status| status.session_id == session_id)),
            _ => Ok(false),
        }
    }

    fn start_structured_claude_chat(&self, chat_dir: PathBuf) -> AppResult<String> {
        let session_id = format!("ccchan-claude-{}", Uuid::new_v4());
        let provider_id = self
            .provider_service
            .get_default_provider()
            .map(|provider| provider.id);

        self.build_structured_claude_command(
            &session_id,
            &chat_dir,
            None,
            provider_id.as_deref(),
            None,
        )?;

        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        *stored = Some(ChatSessionState::ClaudeStructured {
            session_id: session_id.clone(),
            chat_dir,
            claude_session_id: None,
            provider_id: provider_id.clone(),
        });
        info!(
            session_id = %session_id,
            provider_id = provider_id.as_deref().unwrap_or("none"),
            "ccchan structured Claude chat session created"
        );
        self.emit_chat_status(&session_id, "ready", None);
        Ok(session_id)
    }

    fn start_structured_codex_chat(&self, chat_dir: PathBuf) -> AppResult<String> {
        let session_id = format!("ccchan-codex-{}", Uuid::new_v4());
        let provider_id = self
            .provider_service
            .get_default_provider()
            .map(|provider| provider.id);

        self.build_structured_codex_command(
            &session_id,
            &chat_dir,
            None,
            provider_id.as_deref(),
            None,
        )?;

        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        *stored = Some(ChatSessionState::CodexStructured {
            session_id: session_id.clone(),
            chat_dir,
            codex_thread_id: None,
            provider_id: provider_id.clone(),
        });
        info!(
            session_id = %session_id,
            provider_id = provider_id.as_deref().unwrap_or("none"),
            "ccchan structured Codex chat session created"
        );
        self.emit_chat_status(&session_id, "ready", None);
        Ok(session_id)
    }

    fn run_structured_claude_turn(
        &self,
        session_id: &str,
        chat_dir: &Path,
        resume_id: Option<&str>,
        provider_id: Option<&str>,
        text: &str,
    ) -> AppResult<Option<String>> {
        self.emit_chat_status(session_id, "starting", None);
        let spec = self.build_structured_claude_command(
            session_id,
            chat_dir,
            resume_id,
            provider_id,
            Some(text),
        )?;
        let mut command = no_window_command(&spec.command);
        command
            .args(&spec.args)
            .current_dir(chat_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in self.structured_claude_env_vars(session_id, provider_id) {
            command.env(key, value);
        }

        info!(
            session_id,
            resume_id = resume_id.unwrap_or("none"),
            "ccchan structured Claude turn starting"
        );
        let mut child = command.spawn().map_err(|error| {
            AppError::from(format!("Failed to start Claude structured chat: {error}"))
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::from("Claude structured chat stdout is unavailable"))?;
        let mut stderr = child.stderr.take();
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stderr) = stderr.take() {
                let _ = stderr.read_to_string(&mut text);
            }
            text
        });

        let mut next_claude_session_id = resume_id.map(str::to_string);
        let mut last_error: Option<String> = None;
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line.map_err(|error| {
                AppError::from(format!("Failed to read Claude structured output: {error}"))
            })?;
            let Some(parsed) = parse_claude_stream_line(&line) else {
                continue;
            };
            if let Some(claude_session_id) = parsed.session_id {
                next_claude_session_id = Some(claude_session_id);
            }
            if let Some(status) = parsed.status {
                self.emit_chat_status(session_id, status, None);
            }
            if let Some(error) = parsed.error {
                last_error = Some(error);
            }
            if let Some(text) = parsed.text {
                self.emit_chat_output(session_id, &text);
            }
        }

        let status = child.wait().map_err(|error| {
            AppError::from(format!(
                "Failed to wait for Claude structured chat: {error}"
            ))
        })?;
        let stderr_text = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            let exit_message = status.code().map(|code| format!("exit {code}"));
            let message = first_non_empty([
                last_error.as_deref(),
                Some(stderr_text.trim()),
                exit_message.as_deref(),
            ])
            .unwrap_or_else(|| "Claude structured chat failed".to_string());
            self.emit_chat_status(session_id, "error", Some(&message));
            return Err(AppError::from(message));
        }

        if let Some(error) = last_error {
            self.emit_chat_status(session_id, "error", Some(&error));
            return Err(AppError::from(error));
        }

        self.emit_chat_status(session_id, "ready", None);
        Ok(next_claude_session_id)
    }

    fn run_structured_codex_turn(
        &self,
        session_id: &str,
        chat_dir: &Path,
        resume_id: Option<&str>,
        provider_id: Option<&str>,
        text: &str,
    ) -> AppResult<Option<String>> {
        self.emit_chat_status(session_id, "starting", None);
        let spec = self.build_structured_codex_command(
            session_id,
            chat_dir,
            resume_id,
            provider_id,
            Some(text),
        )?;
        let mut command = no_window_command(&spec.command);
        command
            .args(&spec.args)
            .current_dir(chat_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in self.structured_codex_env_vars(session_id, provider_id) {
            command.env(key, value);
        }
        for (key, value) in spec.env_inject {
            command.env(key, value);
        }

        info!(
            session_id,
            resume_id = resume_id.unwrap_or("none"),
            "ccchan structured Codex turn starting"
        );
        let mut child = command.spawn().map_err(|error| {
            AppError::from(format!("Failed to start Codex structured chat: {error}"))
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::from("Codex structured chat stdout is unavailable"))?;
        let mut stderr = child.stderr.take();
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stderr) = stderr.take() {
                let _ = stderr.read_to_string(&mut text);
            }
            text
        });

        let mut next_thread_id = resume_id.map(str::to_string);
        let mut last_error: Option<String> = None;
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line.map_err(|error| {
                AppError::from(format!("Failed to read Codex structured output: {error}"))
            })?;
            let Some(parsed) = parse_codex_stream_line(&line) else {
                continue;
            };
            if let Some(thread_id) = parsed.thread_id {
                next_thread_id = Some(thread_id);
            }
            if let Some(status) = parsed.status {
                self.emit_chat_status(session_id, status, None);
            }
            if let Some(error) = parsed.error {
                last_error = Some(error);
            }
            if let Some(text) = parsed.text {
                self.emit_chat_output(session_id, &text);
            }
        }

        let status = child.wait().map_err(|error| {
            AppError::from(format!("Failed to wait for Codex structured chat: {error}"))
        })?;
        let stderr_text = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            let exit_message = status.code().map(|code| format!("exit {code}"));
            let message = first_non_empty([
                last_error.as_deref(),
                Some(stderr_text.trim()),
                exit_message.as_deref(),
            ])
            .unwrap_or_else(|| "Codex structured chat failed".to_string());
            self.emit_chat_status(session_id, "error", Some(&message));
            return Err(AppError::from(message));
        }

        if let Some(error) = last_error {
            self.emit_chat_status(session_id, "error", Some(&error));
            return Err(AppError::from(error));
        }

        self.emit_chat_status(session_id, "ready", None);
        Ok(next_thread_id)
    }

    fn build_structured_claude_command(
        &self,
        session_id: &str,
        chat_dir: &Path,
        resume_id: Option<&str>,
        provider_id: Option<&str>,
        prompt: Option<&str>,
    ) -> AppResult<ClaudeCommandSpec> {
        let provider = provider_id
            .and_then(|id| self.provider_service.get_provider(id))
            .map(to_cli_provider);
        let adapter = ClaudeAdapter::new();
        let ctx = CliAdapterContext {
            session_id: session_id.to_string(),
            project_path: chat_dir.to_string_lossy().to_string(),
            workspace_path: None,
            provider,
            executable_override: self
                .settings_service
                .get_settings()
                .cli_launchers
                .command_for("claude")
                .map(str::to_string),
            adapter_options: Default::default(),
            resume_id: resume_id.map(str::to_string),
            issued_session_id: None,
            skip_mcp: true,
            yolo_mode: false,
            append_system_prompt: Some(CCCHAN_HELPER_PROMPT.to_string()),
            initial_prompt: prompt.map(str::to_string),
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: self.app_paths.data_dir().to_path_buf(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
        };
        let result = adapter
            .build_command(&ctx)
            .map_err(|error| AppError::from(error.to_string()))?;
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];
        args.extend(result.args);
        Ok(ClaudeCommandSpec {
            command: result.command,
            args,
            env_remove: result.env_remove,
        })
    }

    fn build_structured_codex_command(
        &self,
        session_id: &str,
        chat_dir: &Path,
        resume_id: Option<&str>,
        provider_id: Option<&str>,
        prompt: Option<&str>,
    ) -> AppResult<CodexCommandSpec> {
        let provider = provider_id
            .and_then(|id| self.provider_service.get_provider(id))
            .map(to_cli_provider);
        let adapter = CodexAdapter::new();
        let ctx = CliAdapterContext {
            session_id: session_id.to_string(),
            project_path: chat_dir.to_string_lossy().to_string(),
            workspace_path: None,
            provider,
            executable_override: self
                .settings_service
                .get_settings()
                .cli_launchers
                .command_for("codex")
                .map(str::to_string),
            adapter_options: Default::default(),
            resume_id: resume_id.map(str::to_string),
            issued_session_id: None,
            skip_mcp: true,
            yolo_mode: false,
            append_system_prompt: Some(CCCHAN_HELPER_PROMPT.to_string()),
            initial_prompt: prompt.map(str::to_string),
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: self.app_paths.data_dir().to_path_buf(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
        };
        let result = adapter
            .build_command(&ctx)
            .map_err(|error| AppError::from(error.to_string()))?;
        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--skip-git-repo-check".to_string(),
        ];
        args.extend(result.args);
        Ok(CodexCommandSpec {
            command: result.command,
            args,
            env_remove: result.env_remove,
            env_inject: result.env_inject,
        })
    }

    fn structured_claude_env_vars(
        &self,
        session_id: &str,
        provider_id: Option<&str>,
    ) -> HashMap<String, String> {
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        if let Some(provider_id) = provider_id {
            env_vars.extend(self.provider_service.get_env_vars(Some(provider_id)));
        }
        env_vars
            .entry("TERM".to_string())
            .or_insert_with(|| "xterm-256color".to_string());
        env_vars
            .entry("COLORTERM".to_string())
            .or_insert_with(|| "truecolor".to_string());
        env_vars.insert("CC_PANES_CLI_TOOL".to_string(), "claude".to_string());
        env_vars.insert("CC_PANES_RUNTIME_KIND".to_string(), "local".to_string());
        env_vars.insert(
            "CC_PANES_CCCHAN_SESSION_ID".to_string(),
            session_id.to_string(),
        );
        env_vars
    }

    fn structured_codex_env_vars(
        &self,
        session_id: &str,
        provider_id: Option<&str>,
    ) -> HashMap<String, String> {
        let mut env_vars = self.settings_service.get_proxy_env_vars();
        if let Some(provider_id) = provider_id {
            env_vars.extend(self.provider_service.get_env_vars(Some(provider_id)));
        }
        env_vars
            .entry("TERM".to_string())
            .or_insert_with(|| "xterm-256color".to_string());
        env_vars
            .entry("COLORTERM".to_string())
            .or_insert_with(|| "truecolor".to_string());
        env_vars.insert("CC_PANES_CLI_TOOL".to_string(), "codex".to_string());
        env_vars.insert("CC_PANES_RUNTIME_KIND".to_string(), "local".to_string());
        env_vars.insert(
            "CC_PANES_CCCHAN_SESSION_ID".to_string(),
            session_id.to_string(),
        );
        env_vars
    }

    fn update_structured_claude_session_id(
        &self,
        session_id: &str,
        claude_session_id: String,
    ) -> AppResult<()> {
        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        if let Some(ChatSessionState::ClaudeStructured {
            session_id: stored_id,
            claude_session_id: stored_claude_session_id,
            ..
        }) = stored.as_mut()
        {
            if stored_id == session_id {
                *stored_claude_session_id = Some(claude_session_id);
            }
        }
        Ok(())
    }

    fn update_structured_codex_thread_id(
        &self,
        session_id: &str,
        codex_thread_id: String,
    ) -> AppResult<()> {
        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        if let Some(ChatSessionState::CodexStructured {
            session_id: stored_id,
            codex_thread_id: stored_codex_thread_id,
            ..
        }) = stored.as_mut()
        {
            if stored_id == session_id {
                *stored_codex_thread_id = Some(codex_thread_id);
            }
        }
        Ok(())
    }

    pub fn notify_task_done(&self, session_id: &str, ok: bool) {
        if self.is_chat_session(session_id) {
            debug!(
                session_id,
                ok, "ccchan chat session exit notification suppressed"
            );
            return;
        }
        let kind = if ok { "task-complete" } else { "task-failed" };
        self.emit_ccchan_event(kind, session_id, ok);
    }

    pub fn notify_task_waiting(&self, session_id: &str) {
        if self.is_chat_session(session_id) {
            debug!(session_id, "ccchan chat waiting notification suppressed");
            return;
        }
        self.emit_ccchan_event("task-waiting", session_id, true);
    }

    fn is_chat_session(&self, session_id: &str) -> bool {
        self.chat_session
            .lock()
            .ok()
            .and_then(|stored| {
                stored
                    .as_ref()
                    .map(|session| session.session_id() == session_id)
            })
            .unwrap_or(false)
    }

    /// 用户显式开关宠物时持久化可见性，保证下次启动按最后一次开关恢复。
    /// 仅由 show_ccchan/hide_ccchan 命令调用；ccchan_say 等临时展示不持久化。
    pub fn set_window_visible(&self, visible: bool) -> AppResult<()> {
        let mut settings = self.settings();
        if settings.window_visible == visible {
            return Ok(());
        }
        settings.window_visible = visible;
        self.save_settings(settings)
    }

    fn load_pet(&self, root: &Path, pet_id: &str) -> AppResult<PetMeta> {
        let pet_dir = root.join(pet_id);
        let pet_json_path = pet_dir.join("pet.json");
        let pet_content = std::fs::read_to_string(&pet_json_path).map_err(|error| {
            AppError::from(format!(
                "Failed to read {}: {}",
                pet_json_path.display(),
                error
            ))
        })?;
        let definition: PetDefinition = serde_json::from_str(&pet_content)
            .map_err(|error| AppError::from(format!("Invalid pet.json for {pet_id}: {error}")))?;
        let spritesheet_path = pet_dir.join(&definition.spritesheet_path);

        Ok(PetMeta {
            id: definition.id,
            display_name: definition.display_name,
            description: definition.description,
            spritesheet_url: file_asset_url(&spritesheet_path),
            atlas: definition.atlas,
            animations: definition.animations,
        })
    }

    fn take_chat_session(&self) -> AppResult<Option<ChatSessionState>> {
        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        Ok(stored.take())
    }

    fn clear_chat_session(&self, session_id: &str) -> AppResult<Option<ChatSessionState>> {
        let mut stored = self
            .chat_session
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        if stored
            .as_ref()
            .map(|session| session.session_id() == session_id)
            .unwrap_or(false)
        {
            return Ok(stored.take());
        }
        Ok(None)
    }

    fn stop_existing_chat_for_replacement(
        &self,
        terminal_service: Arc<TerminalService>,
        existing: ChatSessionState,
    ) {
        match existing {
            ChatSessionState::Terminal { session_id } => match terminal_service.kill(&session_id) {
                Ok(()) => {
                    info!(
                        session_id = %session_id,
                        "ccchan replaced previous terminal chat session"
                    );
                }
                Err(error) => {
                    warn!(
                        session_id = %session_id,
                        error = %error,
                        "ccchan failed to stop previous terminal chat session before replacement"
                    );
                }
            },
            ChatSessionState::ClaudeStructured { session_id, .. } => {
                self.emit_chat_status(
                    &session_id,
                    "exited",
                    Some("Claude CLI chat 已被新会话替换。"),
                );
                info!(
                    session_id = %session_id,
                    "ccchan replaced previous structured Claude chat session"
                );
            }
            ChatSessionState::CodexStructured { session_id, .. } => {
                self.emit_chat_status(
                    &session_id,
                    "exited",
                    Some("Codex CLI chat 已被新会话替换。"),
                );
                info!(
                    session_id = %session_id,
                    "ccchan replaced previous structured Codex chat session"
                );
            }
        }
    }

    fn emit_chat_output(&self, session_id: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        let Some(app) = self.app_handle() else {
            debug!(
                session_id,
                text_len = text.len(),
                "ccchan structured chat output skipped before app handle is set"
            );
            return;
        };
        let payload = CCChanChatOutputPayload {
            session_id,
            role: "assistant",
            text,
        };
        if let Err(error) = app.emit(CCCHAN_CHAT_OUTPUT_EVENT, payload) {
            warn!(session_id, error = %error, "failed to emit ccchan chat output");
        }
    }

    fn emit_chat_status(&self, session_id: &str, status: &str, message: Option<&str>) {
        let Some(app) = self.app_handle() else {
            debug!(
                session_id,
                status, "ccchan structured chat status skipped before app handle is set"
            );
            return;
        };
        let payload = CCChanChatStatusPayload {
            session_id,
            status,
            message,
        };
        if let Err(error) = app.emit(CCCHAN_CHAT_STATUS_EVENT, payload) {
            warn!(session_id, status, error = %error, "failed to emit ccchan chat status");
        }
    }

    fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle
            .lock()
            .ok()
            .and_then(|handle| handle.clone())
    }

    fn emit_ccchan_event(&self, kind: &str, session_id: &str, ok: bool) {
        let Some(app) = self.app_handle() else {
            debug!(
                session_id,
                kind, "ccchan event skipped before app handle is set"
            );
            return;
        };

        let payload = serde_json::json!({
            "kind": kind,
            "sessionId": session_id,
            "title": serde_json::Value::Null,
            "ok": ok,
            "ts": current_epoch_seconds(),
        });
        if let Err(error) = app.emit(CCCHAN_EVENT, payload) {
            warn!(session_id, kind, error = %error, "failed to emit ccchan event");
        }
    }
}

pub struct CcChanSessionNotifier {
    inner: Arc<dyn SessionNotifier>,
    ccchan_service: Arc<CCChanService>,
}

impl CcChanSessionNotifier {
    pub fn new(inner: Arc<dyn SessionNotifier>, ccchan_service: Arc<CCChanService>) -> Self {
        Self {
            inner,
            ccchan_service,
        }
    }
}

impl SessionNotifier for CcChanSessionNotifier {
    fn notify_waiting_input(&self, session_id: &str) {
        self.inner.notify_waiting_input(session_id);
        self.ccchan_service.notify_task_waiting(session_id);
    }

    fn notify_session_exited(&self, session_id: &str, exit_code: i32) {
        self.inner.notify_session_exited(session_id, exit_code);
        self.ccchan_service
            .notify_task_done(session_id, exit_code == 0);
    }

    fn cleanup_session(&self, session_id: &str) {
        self.inner.cleanup_session(session_id);
    }
}

fn ccchan_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    if let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        CCCHAN_WINDOW_LABEL,
        WebviewUrl::App("index.html?mode=ccchan".into()),
    )
    .title("cc酱")
    .visible(false)
    .inner_size(120.0, 120.0)
    .position(-9999.0, -9999.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| AppError::from(format!("Failed to create ccchan window: {error}")))
}

fn position_window(window: &WebviewWindow, settings: &CCChanSettings) -> AppResult<()> {
    let (x, y) = match (settings.window_x, settings.window_y) {
        (Some(x), Some(y)) => clamp_position_to_visible(window, x, y),
        _ => (80.0, 80.0),
    };
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| AppError::from(error.to_string()))
}

/// Snap a window position into a currently-attached monitor.
///
/// - If `(x, y)` is already inside any monitor (with a 40px sliver for half-off
///   tolerance), return as-is.
/// - Otherwise pick the monitor closest to `(x, y)` and clamp the position to
///   that monitor's interior (leaving the mascot's full body visible).
/// - If no monitors are attached at all, fall back to (80, 80).
///
/// Used both on startup (resolve stale persisted positions after monitor
/// hot-unplug / DPI change) AND on every drag-release (so a user who drags
/// the mascot off-screen sees it snap back instead of vanishing).
pub fn clamp_position_to_visible(window: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    const PET_SIZE: f64 = 120.0;
    const SAFE_MARGIN: f64 = 8.0;
    const HALF_OFF_TOLERANCE: f64 = 40.0;

    let Ok(monitors) = window.available_monitors() else {
        return (80.0, 80.0);
    };
    if monitors.is_empty() {
        return (80.0, 80.0);
    }

    let already_visible = monitors.iter().any(|m| {
        let (lx, ly, lw, lh) = monitor_logical_rect(m);
        x + HALF_OFF_TOLERANCE > lx
            && x < lx + lw - HALF_OFF_TOLERANCE
            && y + HALF_OFF_TOLERANCE > ly
            && y < ly + lh - HALF_OFF_TOLERANCE
    });
    if already_visible {
        return (x, y);
    }

    let mut best: Option<(f64, f64, f64)> = None;
    for m in &monitors {
        let (lx, ly, lw, lh) = monitor_logical_rect(m);
        let cx = x.clamp(
            lx + SAFE_MARGIN,
            (lx + lw - PET_SIZE - SAFE_MARGIN).max(lx + SAFE_MARGIN),
        );
        let cy = y.clamp(
            ly + SAFE_MARGIN,
            (ly + lh - PET_SIZE - SAFE_MARGIN).max(ly + SAFE_MARGIN),
        );
        let dist = (cx - x).powi(2) + (cy - y).powi(2);
        if best.is_none_or(|b| dist < b.0) {
            best = Some((dist, cx, cy));
        }
    }
    best.map(|(_, cx, cy)| (cx, cy)).unwrap_or((80.0, 80.0))
}

fn monitor_logical_rect(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    (
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

fn parse_ai_engine(ai_engine: &str) -> AppResult<CliTool> {
    match ai_engine.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok(CliTool::Claude),
        "codex" => Ok(CliTool::Codex),
        other => Err(AppError::from(format!(
            "Unsupported ccchan aiEngine '{}'; expected 'claude' or 'codex'",
            other
        ))),
    }
}

fn resolve_ccchan_root(app: &AppHandle) -> AppResult<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let root = resource_dir.join("resources").join("ccchan");
        if root.exists() {
            return Ok(root);
        }
    }

    let cwd = std::env::current_dir()?;
    for candidate in [
        cwd.join("src-tauri").join("resources").join("ccchan"),
        cwd.join("resources").join("ccchan"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::from("ccchan resources not found"))
}

fn file_asset_url(path: &Path) -> String {
    let path_text = path.to_string_lossy();
    let encoded = urlencoding::encode(&path_text);
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

fn current_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn parse_claude_stream_line(line: &str) -> Option<ParsedClaudeLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut parsed = ParsedClaudeLine {
        session_id: stream_session_id(&value).map(str::to_string),
        ..ParsedClaudeLine::default()
    };

    match event_type {
        "assistant" => {
            if contains_thinking_content(&value) {
                parsed.status = Some("thinking");
            }
            parsed.text = extract_assistant_text(&value);
        }
        "content" | "text" => {
            parsed.text = value
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "content_block_delta" => {
            parsed.text = value
                .pointer("/delta/text")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "thinking" | "thought" => {
            parsed.status = Some("thinking");
        }
        "agent_status" => {
            parsed.status = value
                .get("status")
                .and_then(Value::as_str)
                .and_then(structured_status);
        }
        "result"
            if value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            parsed.error = value
                .get("error")
                .or_else(|| value.get("result"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        _ => {}
    }

    if parsed.text.as_deref().unwrap_or_default().is_empty() {
        parsed.text = None;
    }
    if parsed.status.is_none()
        && parsed.text.is_none()
        && parsed.session_id.is_none()
        && parsed.error.is_none()
    {
        return None;
    }
    Some(parsed)
}

fn parse_codex_stream_line(line: &str) -> Option<ParsedCodexLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut parsed = ParsedCodexLine {
        thread_id: stream_thread_id(&value).map(str::to_string),
        ..ParsedCodexLine::default()
    };

    match event_type {
        "thread.started" => {}
        "turn.started" => {
            parsed.status = Some("thinking");
        }
        "turn.completed" => {
            parsed.status = Some("ready");
        }
        "turn.failed" | "error" => {
            parsed.error = extract_codex_error(&value);
        }
        "item.completed" | "item.updated" | "item.failed" => {
            if let Some(item) = value.get("item") {
                parsed.text = extract_codex_item_text(item);
                parsed.error = extract_codex_error(item);
            }
        }
        "agent_message" | "message" => {
            parsed.text = extract_codex_item_text(&value);
        }
        _ => {}
    }

    if parsed.text.as_deref().unwrap_or_default().is_empty() {
        parsed.text = None;
    }
    if parsed.status.is_none()
        && parsed.text.is_none()
        && parsed.thread_id.is_none()
        && parsed.error.is_none()
    {
        return None;
    }
    Some(parsed)
}

fn extract_assistant_text(value: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(content) = value.pointer("/message/content") {
        collect_text_content(content, &mut parts);
    }
    if parts.is_empty() {
        if let Some(content) = value.get("content") {
            collect_text_content(content, &mut parts);
        }
    }
    if parts.is_empty() {
        if let Some(text) = value.pointer("/message/delta/text").and_then(Value::as_str) {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(""))
}

fn extract_codex_item_text(value: &Value) -> Option<String> {
    let item_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let role = value
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        item_type,
        "agent_message" | "message" | "assistant_message" | ""
    ) || (!role.is_empty() && role != "assistant")
    {
        return None;
    }

    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(content) = value.get("content") {
        let mut parts = Vec::new();
        collect_text_content(content, &mut parts);
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    None
}

fn extract_codex_error(value: &Value) -> Option<String> {
    [
        "/error/message",
        "/error",
        "/message",
        "/item/error/message",
        "/item/error",
        "/item/message",
    ]
    .iter()
    .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .map(str::to_string)
}

fn collect_text_content(content: &Value, parts: &mut Vec<String>) {
    match content {
        Value::String(text) => parts.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                if matches!(item_type, "text" | "output_text" | "") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                parts.push(text.to_string());
            }
        }
        _ => {}
    }
}

fn contains_thinking_content(value: &Value) -> bool {
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("thinking") | Some("redacted_thinking")
                )
            })
        })
        .unwrap_or(false)
}

fn stream_session_id(value: &Value) -> Option<&str> {
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(Value::as_str)
}

fn stream_thread_id(value: &Value) -> Option<&str> {
    value
        .get("thread_id")
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
}

fn structured_status(status: &str) -> Option<&'static str> {
    match status {
        "thinking" | "working" | "running" => Some("thinking"),
        "ready" | "completed" | "done" => Some("ready"),
        "error" | "failed" => Some("error"),
        _ => None,
    }
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn to_cli_provider(provider: crate::models::provider::Provider) -> CliProvider {
    CliProvider {
        id: provider.id,
        name: provider.name,
        provider_type: serde_json::to_value(provider.provider_type)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string()),
        api_key: provider.api_key,
        base_url: provider.base_url,
        region: provider.region,
        project_id: provider.project_id,
        aws_profile: provider.aws_profile,
        config_dir: provider.config_dir,
        is_default: provider.is_default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_text_without_thinking_content() {
        let parsed = parse_claude_stream_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"你好，结构化正文。"}]}}"#,
        )
        .expect("assistant line should parse");

        assert_eq!(parsed.text.as_deref(), Some("你好，结构化正文。"));
        assert_eq!(parsed.status, Some("thinking"));
    }

    #[test]
    fn parses_session_id_from_init_and_ignores_result_text() {
        let init = parse_claude_stream_line(
            r#"{"type":"system","subtype":"init","session_id":"claude-session-1"}"#,
        )
        .expect("init line should parse");
        assert_eq!(init.session_id.as_deref(), Some("claude-session-1"));
        assert_eq!(init.text, None);

        let result = parse_claude_stream_line(
            r#"{"type":"result","subtype":"success","session_id":"claude-session-1","result":"不要重复进气泡"}"#,
        )
        .expect("result line should parse for session id");
        assert_eq!(result.session_id.as_deref(), Some("claude-session-1"));
        assert_eq!(result.text, None);
    }

    #[test]
    fn parses_error_result_as_error_not_assistant_text() {
        let parsed = parse_claude_stream_line(
            r#"{"type":"result","subtype":"error","is_error":true,"error":"boom","result":"boom"}"#,
        )
        .expect("error result should parse");

        assert_eq!(parsed.error.as_deref(), Some("boom"));
        assert_eq!(parsed.text, None);
    }

    #[test]
    fn parses_codex_thread_id_and_agent_message() {
        let thread = parse_codex_stream_line(
            r#"{"type":"thread.started","thread_id":"019eb100-092d-7aa3-9fb4-600e0c3ef5ab"}"#,
        )
        .expect("thread line should parse");
        assert_eq!(
            thread.thread_id.as_deref(),
            Some("019eb100-092d-7aa3-9fb4-600e0c3ef5ab")
        );
        assert_eq!(thread.text, None);

        let message = parse_codex_stream_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}"#,
        )
        .expect("agent message should parse");
        assert_eq!(message.text.as_deref(), Some("OK"));
        assert_eq!(message.thread_id, None);
    }

    #[test]
    fn parses_codex_status_and_error() {
        let started = parse_codex_stream_line(r#"{"type":"turn.started"}"#)
            .expect("turn started should parse");
        assert_eq!(started.status, Some("thinking"));

        let failed =
            parse_codex_stream_line(r#"{"type":"turn.failed","error":{"message":"Codex failed"}}"#)
                .expect("turn failed should parse");
        assert_eq!(failed.error.as_deref(), Some("Codex failed"));
    }
}
