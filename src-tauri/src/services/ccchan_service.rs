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
use cc_panes_core::services::terminal_service::KillReason;
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

/// ccchan 窗口的四种交互态；尺寸由 `CCChanService::window_size` 统一计算，
/// 前端 `web/ccchan/ccchanLayout.ts` 保持同一公式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CCChanWindowMode {
    Collapsed,
    Bubble,
    Menu,
    Chat,
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

    pub fn pet_size(&self) -> f64 {
        self.settings().pet_size
    }

    pub fn window_size(&self, mode: CCChanWindowMode) -> (f64, f64) {
        let s = self.pet_size();
        window_size_for(mode, s)
    }

    pub fn user_pets_dir(&self) -> PathBuf {
        self.app_paths.data_dir().join("ccchan").join("pets")
    }

    /// 确保用户皮肤目录存在，并在首次创建时放一份 README 模板，
    /// 告诉用户 pet.json 的完整格式。已有 README 不覆盖。
    pub fn ensure_user_pets_dir_scaffold(&self) -> AppResult<PathBuf> {
        let dir = self.user_pets_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|error| AppError::from(format!("cannot create pets dir: {error}")))?;
        let readme = dir.join("README.md");
        if !readme.exists() {
            if let Err(error) = std::fs::write(&readme, USER_PETS_README) {
                warn!(%error, "failed to write ccchan pets README");
            }
        }
        Ok(dir)
    }

    pub fn show_window(&self, app: &AppHandle) -> AppResult<()> {
        let window = ccchan_window(app)?;
        let (width, height) = self.window_size(CCChanWindowMode::Collapsed);
        window
            .set_size(LogicalSize::new(width, height))
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

    /// 关闭桌宠时直接销毁窗口而非隐藏：长期隐藏的 WebView2 会被系统置为
    /// 失效状态（0x8007139F），之后所有 emit 广播对它投递失败形成日志洪水。
    /// 窗口不存在时为幂等 no-op（不能走 ccchan_window() 的 get-or-create，
    /// 否则"隐藏"反而会先创建一个隐藏 WebView）。下次启用经 show_window 重建。
    pub fn hide_window(&self, app: &AppHandle) -> AppResult<()> {
        let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) else {
            return Ok(());
        };
        window
            .close()
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

        let built_in = manifest
            .pets
            .iter()
            .map(|pet_id| self.load_pet(&root, pet_id))
            .collect::<AppResult<Vec<_>>>()?;
        Ok(merge_pets(built_in, self.load_user_pets()))
    }

    /// 扫描用户皮肤目录（data_dir/ccchan/pets/<folder>/pet.json）。目录不存在或
    /// 单个皮肤非法都不算错误——warn 跳过，保证内置角色始终可用。
    fn load_user_pets(&self) -> Vec<PetMeta> {
        let pets_dir = self.user_pets_dir();
        let Ok(entries) = std::fs::read_dir(&pets_dir) else {
            return Vec::new();
        };
        let mut pet_dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        // 按目录名排序遍历，重复 id 时保证覆盖结果确定。
        pet_dirs.sort();

        let mut pets = Vec::new();
        for pet_dir in pet_dirs {
            if !pet_dir.join("pet.json").is_file() {
                continue;
            }
            match load_user_pet(&pet_dir) {
                Ok(pet) => {
                    info!(dir = %pet_dir.display(), id = %pet.id, "loaded user ccchan pet");
                    pets.push(pet);
                }
                Err(error) => {
                    warn!(dir = %pet_dir.display(), %error, "skipping invalid user ccchan pet");
                }
            }
        }
        pets
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
                match terminal_service.kill_with_reason(session_id, KillReason::UserClose) {
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
            // 结构化模式不走 CLI 启动器覆盖：包装器（如 reclaude）转发含换行的
            // argv 时会吞掉后续参数——ccchan 每轮必带多行 --append-system-prompt，
            // 位置 prompt 被吞后 claude -p 直接报 "Input must be provided..."。
            // 覆盖只面向交互式终端启动，程序化调用直连真实 CLI。
            executable_override: None,
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
            // 同 Claude 侧：结构化 exec 调用不走启动器覆盖（包装器换行 argv 吞参问题）
            executable_override: None,
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
            ChatSessionState::Terminal { session_id } => {
                match terminal_service.kill_with_reason(&session_id, KillReason::UserClose) {
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
                }
            }
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

/// 各窗口态尺寸公式：s=120 时还原历史固定值（Collapsed 120×120、Bubble
/// 300×220、Menu 300×280、Chat 460×680），s 更大时按增量放大，更小时不低于
/// 历史值下限。前端 `web/ccchan/ccchanLayout.ts` 必须保持同一公式。
pub fn window_size_for(mode: CCChanWindowMode, pet_size: f64) -> (f64, f64) {
    let s = pet_size;
    match mode {
        CCChanWindowMode::Collapsed => (s, s),
        CCChanWindowMode::Bubble => ((s + 180.0).max(300.0), (s + 100.0).max(220.0)),
        CCChanWindowMode::Menu => ((s + 180.0).max(300.0), (s + 160.0).max(280.0)),
        CCChanWindowMode::Chat => ((s + 340.0).max(460.0), (s + 560.0).max(680.0)),
    }
}

/// 合并内置与用户皮肤：同 id 时用户版覆盖内置（re-skin），新 id 追加在后。
fn merge_pets(built_in: Vec<PetMeta>, user: Vec<PetMeta>) -> Vec<PetMeta> {
    let mut pets = built_in;
    for user_pet in user {
        if let Some(existing) = pets.iter_mut().find(|pet| pet.id == user_pet.id) {
            *existing = user_pet;
        } else {
            pets.push(user_pet);
        }
    }
    pets
}

/// 首次打开用户皮肤目录时生成的说明文件（`ensure_user_pets_dir_scaffold`）。
const USER_PETS_README: &str = r#"# CC-Panes 自定义宠物（cc酱皮肤）

在本目录下为每个自定义角色建一个文件夹：

```
pets/
└── my-pet/                 # 文件夹名随意，建议与 id 一致
    ├── pet.json            # 角色定义（必需）
    └── spritesheet.png     # 精灵图（png / webp / gif / jpg，≤ 20MB）
```

## pet.json 格式

```json
{
  "id": "my-pet",
  "displayName": "我的宠物",
  "description": "一句话介绍",
  "spritesheetPath": "spritesheet.png",
  "atlas": { "cellW": 192, "cellH": 208, "cols": 8, "rows": 9 },
  "animations": {
    "idle":    { "row": 0, "frames": 4, "fps": 8 },
    "working": { "row": 1, "frames": 6, "fps": 10 },
    "waiting": { "row": 2, "frames": 4, "fps": 6 },
    "happy":   { "row": 3, "frames": 6, "fps": 10 },
    "sad":     { "row": 4, "frames": 4, "fps": 6 },
    "thinking":{ "row": 5, "frames": 4, "fps": 6 },
    "walking": { "row": 6, "frames": 6, "fps": 10 }
  }
}
```

## 字段说明

- `atlas`：精灵图按网格切帧。`cellW`/`cellH` 是单帧像素尺寸，`cols`/`rows` 是网格列数/行数。
- `animations`：每个状态一行动画。`row` 是该动画所在的行（从 0 开始，必须 < rows），
  `frames` 是帧数（从该行第 0 列开始取），`fps` 是播放速度（1~60）。
  可选 `colOffset` 指定起始列。
- 状态可用：`idle` / `working` / `waiting` / `happy` / `sad` / `thinking` / `walking` / `jumping`。
  只有 `idle` 是必要的——缺失的状态会自动回退到 idle。
- `spritesheetPath` 必须是本文件夹内的相对路径（不允许绝对路径和 `..`）。

## 提示

- `id` 与内置角色相同（`homie` / `doro.codex-pet`）时会**覆盖**内置形象（换皮）。
- 改完后到 设置 → cc酱 → 「刷新角色列表」，在「默认角色」下拉里选择即可。
- 参考模板可直接复制安装目录 `resources/ccchan/homie/` 里的文件。
- pet.json 不合法时该角色会被跳过（日志里有 warn），不影响其他角色。
"#;

const USER_PET_JSON_MAX_BYTES: u64 = 64 * 1024;
const USER_PET_SPRITESHEET_MAX_BYTES: u64 = 20 * 1024 * 1024;
const USER_PET_IMAGE_EXTENSIONS: [&str; 5] = ["png", "webp", "gif", "jpg", "jpeg"];

fn load_user_pet(pet_dir: &Path) -> AppResult<PetMeta> {
    let pet_json_path = pet_dir.join("pet.json");
    let json_len = std::fs::metadata(&pet_json_path)
        .map_err(|error| AppError::from(format!("cannot stat pet.json: {error}")))?
        .len();
    if json_len > USER_PET_JSON_MAX_BYTES {
        return Err(AppError::from(format!(
            "pet.json too large ({json_len} bytes, max {USER_PET_JSON_MAX_BYTES})"
        )));
    }
    let content = std::fs::read_to_string(&pet_json_path)
        .map_err(|error| AppError::from(format!("cannot read pet.json: {error}")))?;
    let definition: PetDefinition = serde_json::from_str(&content)
        .map_err(|error| AppError::from(format!("invalid pet.json: {error}")))?;
    validate_pet_definition(&definition)?;
    let spritesheet_path = resolve_user_spritesheet(pet_dir, &definition.spritesheet_path)?;

    Ok(PetMeta {
        id: definition.id,
        display_name: definition.display_name,
        description: definition.description,
        spritesheet_url: file_asset_url(&spritesheet_path),
        atlas: definition.atlas,
        animations: definition.animations,
    })
}

fn validate_pet_definition(definition: &PetDefinition) -> AppResult<()> {
    if definition.id.trim().is_empty() {
        return Err(AppError::from("pet.json id is empty"));
    }
    let atlas = &definition.atlas;
    if atlas.cell_w == 0 || atlas.cell_h == 0 || atlas.cols == 0 || atlas.rows == 0 {
        return Err(AppError::from("pet.json atlas dimensions must be positive"));
    }
    for (state, animation) in &definition.animations {
        if animation.row >= atlas.rows {
            return Err(AppError::from(format!(
                "animation '{state}' row {} out of atlas rows {}",
                animation.row, atlas.rows
            )));
        }
        if animation.frames == 0 {
            return Err(AppError::from(format!(
                "animation '{state}' has zero frames"
            )));
        }
        if !(1..=60).contains(&animation.fps) {
            return Err(AppError::from(format!(
                "animation '{state}' fps {} out of range 1..=60",
                animation.fps
            )));
        }
    }
    Ok(())
}

/// 用户 spritesheetPath 只允许指向 pet 目录内部的图片文件：拒绝绝对路径、
/// `..`、symlink 逃逸和非图片扩展名（asset scope 是 `**`，必须在这里兜安全）。
fn resolve_user_spritesheet(pet_dir: &Path, sprite_rel: &str) -> AppResult<PathBuf> {
    let rel = Path::new(sprite_rel);
    if rel.is_absolute() {
        return Err(AppError::from("spritesheetPath must be relative"));
    }
    if rel
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::from("spritesheetPath must not contain '..'"));
    }
    let extension = rel
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if !USER_PET_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::from(format!(
            "spritesheetPath extension '{extension}' is not an allowed image type"
        )));
    }

    let candidate = pet_dir.join(rel);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| AppError::from(format!("spritesheet not found: {error}")))?;
    let canonical_dir = pet_dir
        .canonicalize()
        .map_err(|error| AppError::from(format!("cannot canonicalize pet dir: {error}")))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(AppError::from("spritesheetPath escapes the pet directory"));
    }
    let sprite_len = std::fs::metadata(&canonical)
        .map_err(|error| AppError::from(format!("cannot stat spritesheet: {error}")))?
        .len();
    if sprite_len > USER_PET_SPRITESHEET_MAX_BYTES {
        return Err(AppError::from(format!(
            "spritesheet too large ({sprite_len} bytes, max {USER_PET_SPRITESHEET_MAX_BYTES})"
        )));
    }
    // asset URL 用未 canonicalize 的路径，避免 Windows `\\?\` 前缀进 URL。
    Ok(candidate)
}

fn position_window(window: &WebviewWindow, settings: &CCChanSettings) -> AppResult<()> {
    let (x, y) = match (settings.window_x, settings.window_y) {
        (Some(x), Some(y)) => clamp_position_to_visible(window, x, y, settings.pet_size),
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
pub fn clamp_position_to_visible(
    window: &WebviewWindow,
    x: f64,
    y: f64,
    pet_size: f64,
) -> (f64, f64) {
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
            (lx + lw - pet_size - SAFE_MARGIN).max(lx + SAFE_MARGIN),
        );
        let cy = y.clamp(
            ly + SAFE_MARGIN,
            (ly + lh - pet_size - SAFE_MARGIN).max(ly + SAFE_MARGIN),
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

    fn pet_meta(id: &str, name: &str) -> PetMeta {
        PetMeta {
            id: id.to_string(),
            display_name: name.to_string(),
            description: String::new(),
            spritesheet_url: String::new(),
            atlas: PetAtlas {
                cell_w: 192,
                cell_h: 208,
                cols: 8,
                rows: 9,
            },
            animations: HashMap::new(),
        }
    }

    #[test]
    fn window_size_for_restores_legacy_values_at_default_pet_size() {
        assert_eq!(
            window_size_for(CCChanWindowMode::Collapsed, 120.0),
            (120.0, 120.0)
        );
        assert_eq!(
            window_size_for(CCChanWindowMode::Bubble, 120.0),
            (300.0, 220.0)
        );
        assert_eq!(
            window_size_for(CCChanWindowMode::Menu, 120.0),
            (300.0, 280.0)
        );
        assert_eq!(
            window_size_for(CCChanWindowMode::Chat, 120.0),
            (460.0, 680.0)
        );
    }

    #[test]
    fn window_size_for_scales_up_and_floors_below_default() {
        assert_eq!(
            window_size_for(CCChanWindowMode::Collapsed, 240.0),
            (240.0, 240.0)
        );
        assert_eq!(
            window_size_for(CCChanWindowMode::Bubble, 240.0),
            (420.0, 340.0)
        );
        // 小尺寸不低于历史窗口下限（气泡/菜单/chat 内容不缩水）
        assert_eq!(
            window_size_for(CCChanWindowMode::Bubble, 80.0),
            (300.0, 220.0)
        );
        assert_eq!(
            window_size_for(CCChanWindowMode::Chat, 80.0),
            (460.0, 680.0)
        );
    }

    #[test]
    fn merge_pets_user_overrides_built_in_by_id_and_appends_new() {
        let built_in = vec![pet_meta("homie", "Homie"), pet_meta("doro", "Doro")];
        let user = vec![
            pet_meta("homie", "Custom Homie"),
            pet_meta("my-pet", "Mine"),
        ];

        let merged = merge_pets(built_in, user);

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, "homie");
        assert_eq!(merged[0].display_name, "Custom Homie");
        assert_eq!(merged[1].id, "doro");
        assert_eq!(merged[2].id, "my-pet");
    }

    fn write_user_pet(dir: &Path, sprite_name: &str, pet_json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("pet.json"), pet_json).unwrap();
        if !sprite_name.is_empty() {
            std::fs::write(dir.join(sprite_name), b"fake-png").unwrap();
        }
    }

    fn valid_pet_json(sprite_path: &str) -> String {
        format!(
            r#"{{"id":"my-pet","displayName":"Mine","description":"d","spritesheetPath":"{sprite_path}","atlas":{{"cellW":192,"cellH":208,"cols":8,"rows":9}},"animations":{{"idle":{{"row":0,"frames":4,"fps":8}}}}}}"#
        )
    }

    #[test]
    fn load_user_pet_accepts_valid_pet() {
        let temp = tempfile::tempdir().unwrap();
        let pet_dir = temp.path().join("my-pet");
        write_user_pet(
            &pet_dir,
            "spritesheet.png",
            &valid_pet_json("spritesheet.png"),
        );

        let pet = load_user_pet(&pet_dir).expect("valid pet should load");
        assert_eq!(pet.id, "my-pet");
        assert!(pet.spritesheet_url.contains("spritesheet.png"));
    }

    #[test]
    fn load_user_pet_rejects_path_escape_and_absolute_paths() {
        let temp = tempfile::tempdir().unwrap();
        let pet_dir = temp.path().join("evil");
        write_user_pet(&pet_dir, "", &valid_pet_json("../escape.png"));
        assert!(load_user_pet(&pet_dir).is_err());

        let abs = if cfg!(windows) {
            "C:/Windows/x.png"
        } else {
            "/etc/x.png"
        };
        std::fs::write(pet_dir.join("pet.json"), valid_pet_json(abs)).unwrap();
        assert!(load_user_pet(&pet_dir).is_err());
    }

    #[test]
    fn load_user_pet_rejects_bad_extension_and_invalid_atlas() {
        let temp = tempfile::tempdir().unwrap();
        let pet_dir = temp.path().join("bad-ext");
        write_user_pet(&pet_dir, "payload.exe", &valid_pet_json("payload.exe"));
        assert!(load_user_pet(&pet_dir).is_err());

        let pet_dir2 = temp.path().join("bad-atlas");
        let bad_atlas = valid_pet_json("spritesheet.png").replace(r#""rows":9"#, r#""rows":0"#);
        write_user_pet(&pet_dir2, "spritesheet.png", &bad_atlas);
        assert!(load_user_pet(&pet_dir2).is_err());

        let pet_dir3 = temp.path().join("bad-anim");
        let bad_anim = valid_pet_json("spritesheet.png").replace(r#""fps":8"#, r#""fps":600"#);
        write_user_pet(&pet_dir3, "spritesheet.png", &bad_anim);
        assert!(load_user_pet(&pet_dir3).is_err());
    }

    #[test]
    fn load_user_pet_rejects_broken_json() {
        let temp = tempfile::tempdir().unwrap();
        let pet_dir = temp.path().join("broken");
        write_user_pet(&pet_dir, "spritesheet.png", "{not json");
        assert!(load_user_pet(&pet_dir).is_err());
    }

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
