//! Bot 联系人：常驻的 ACP 对话主体（人设 + 固定工作目录 + 一条长期线程）。
//!
//! 一个 Bot = 引擎 + 人设 + cwd + 记住的 `acpSessionId`。对话本身仍是普通的
//! ACP chat，chatId 固定为 `bot-{id}`——界面标签与 IM 入站共用同一个活进程，
//! 谁先到谁拉起，另一方直接附着。
//!
//! 人设注入（ACP 没有 system prompt 字段）：
//! - 不指定 cwd：Bot 住在自己的家目录 `<data>/bots/<id>/home/`，人设写成
//!   `CLAUDE.md` + `AGENTS.md`，claude / codex 原生读取，压缩上下文也不丢；
//! - 绑定项目 cwd：不往用户仓库写文件，新线程的第一条消息带隐藏前言。
//!
//! 存储与 Automations 同一先例（文件，免 DB migration）：
//! `<data>/bots/<id>/bot.json`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

use crate::commands::{ccpanes_mcp_servers, engine_spec, resolve_engine_launch};
use crate::services::{
    AcpChatEvent, AcpChatPhase, AcpChatService, AcpChatSnapshot, PromptAnnouncement,
};
use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::AppPaths;

pub const BOTS_CHANGED_EVENT: &str = "bots-changed";
pub const BOT_CHAT_PREFIX: &str = "bot-";
/// 界面据此在用户气泡上标出「来自 IM」。
pub const EXTERNAL_PROMPT_EVENT_KIND: &str = "external_prompt";

/// IM 送来的消息最多等多久前一轮（界面里手动发起的）结束。
const WAIT_READY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WAIT_READY_POLL: Duration = Duration::from_millis(400);
/// 一轮回复的硬上限：超时取消该轮，避免 IM 侧无限挂起。
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const NAME_MAX: usize = 40;
const PERSONA_MAX: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// 单个 emoji（空 = 用名字首字）。
    #[serde(default)]
    pub avatar: String,
    /// 头像底色（CSS 颜色）。
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub persona: String,
    /// ACP 引擎 id（内置或 engines.json 自定义）。
    pub engine_id: String,
    /// 绑定的项目目录；None = 住在 Bot 自己的家目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub auto_approve_kinds: Vec<String>,
    /// 当前长期线程。None = 下次启动开新线程。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// 列表视图：Bot 本体 + 运行态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSummary {
    #[serde(flatten)]
    pub bot: Bot,
    pub chat_id: String,
    pub effective_cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<AcpChatPhase>,
}

/// 外部（IM）消息的来源，进 `external_prompt` 事件载荷。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BotMessageOrigin {
    Im,
}

pub fn bot_chat_id(bot_id: &str) -> String {
    format!("{BOT_CHAT_PREFIX}{bot_id}")
}

fn valid_bot_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn persona_markdown(bot: &Bot) -> String {
    let persona = bot.persona.trim();
    let mut out = format!(
        "# {}\n\n<!-- 由 CC-Panes 管理：在 Bot 设置里修改人设，此文件会被覆盖。 -->\n\n",
        bot.name.trim()
    );
    if persona.is_empty() {
        out.push_str(&format!(
            "你是「{}」，一个乐于助人的助手。\n",
            bot.name.trim()
        ));
    } else {
        out.push_str(persona);
        out.push('\n');
    }
    out
}

/// 项目 cwd 模式下新线程首条消息的隐藏前言。
fn persona_preamble(bot: &Bot) -> Option<String> {
    let persona = bot.persona.trim();
    if persona.is_empty() {
        return None;
    }
    Some(format!(
        "[Bot 设定：以下是你在本对话中的身份与工作方式，请始终遵守，不必复述]\n名字：{}\n\n{}",
        bot.name.trim(),
        persona
    ))
}

/// 本条外部消息的公告事件（`external_prompt` 且 `promptId` 相同）。
pub fn is_own_external_prompt(event: &AcpChatEvent, chat_id: &str, prompt_id: &str) -> bool {
    event.chat_id == chat_id
        && event.kind == EXTERNAL_PROMPT_EVENT_KIND
        && event.payload["promptId"].as_str() == Some(prompt_id)
}

/// 从事件流里拼出一轮的助手文本（只取主 agent 的 `agent_message_chunk`，
/// 子 agent 的输出不发回 IM）。从本条消息的 `external_prompt` 开始（之前的
/// 是排队期间界面里那一轮的输出），遇到 `turn_ended` 即止。
pub fn collect_reply_text<'a>(
    chat_id: &str,
    prompt_id: &str,
    events: impl IntoIterator<Item = &'a AcpChatEvent>,
) -> String {
    let mut text = String::new();
    let mut started = false;
    for event in events {
        if event.chat_id != chat_id {
            continue;
        }
        if !started {
            started = is_own_external_prompt(event, chat_id, prompt_id);
            continue;
        }
        if event.kind == "turn_ended" {
            break;
        }
        if event.kind != "update" {
            continue;
        }
        let update = &event.payload["update"];
        if update["sessionUpdate"].as_str() != Some("agent_message_chunk") {
            continue;
        }
        let is_subagent = update["_meta"]["claudeCode"]["parentToolUseId"]
            .as_str()
            .is_some_and(|parent| !parent.is_empty());
        if is_subagent {
            continue;
        }
        let content = &update["content"];
        if content["type"].as_str().unwrap_or("text") == "text" {
            if let Some(chunk) = content["text"].as_str() {
                text.push_str(chunk);
            }
        }
    }
    text.trim().to_string()
}

pub struct BotService {
    dir: PathBuf,
    acp: Arc<AcpChatService>,
    app_paths: Arc<AppPaths>,
    /// 生命周期锁（每个 Bot 一把）：启动 / 换线程 / 改配置 / 删除互斥，
    /// 只在这些短动作期间持有，**不**跨回合。
    lifecycle_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// IM 提交队列锁（每个 Bot 一把）：外部消息按到达顺序串行，持有整轮；
    /// 与生命周期锁分开，长回合不挡开新话题 / 删除 / 界面启动。
    queue_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl BotService {
    pub fn new(dir: PathBuf, acp: Arc<AcpChatService>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            dir,
            acp,
            app_paths,
            lifecycle_locks: std::sync::Mutex::new(HashMap::new()),
            queue_locks: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn bot_dir(&self, bot_id: &str) -> AppResult<PathBuf> {
        let id = bot_id.trim();
        if !valid_bot_id(id) {
            return Err(AppError::coded("BOT_BAD_ID", "Bot id is invalid"));
        }
        Ok(self.dir.join(id))
    }

    pub fn home_dir(&self, bot_id: &str) -> AppResult<PathBuf> {
        Ok(self.bot_dir(bot_id)?.join("home"))
    }

    fn effective_cwd(&self, bot: &Bot) -> AppResult<String> {
        match bot
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
        {
            Some(cwd) => Ok(cwd.to_string()),
            None => Ok(self.home_dir(&bot.id)?.to_string_lossy().into_owned()),
        }
    }

    fn lifecycle_lock(&self, bot_id: &str) -> Arc<Mutex<()>> {
        lock_in(&self.lifecycle_locks, bot_id)
    }

    fn queue_lock(&self, bot_id: &str) -> Arc<Mutex<()>> {
        lock_in(&self.queue_locks, bot_id)
    }

    async fn chat_phase(&self, chat_id: &str) -> Option<AcpChatPhase> {
        self.acp
            .snapshot(chat_id)
            .await
            .map(|snapshot| snapshot.phase)
    }

    /// 停掉 Bot 的会话：先取消进行中的回合（IM 那边会收到「已取消」），再停进程。
    async fn stop_chat(&self, chat_id: &str) {
        let _ = self.acp.cancel(chat_id).await;
        let _ = self.acp.stop(chat_id).await;
    }

    pub fn list_bots(&self) -> Vec<Bot> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut bots: Vec<Bot> = entries
            .flatten()
            .filter_map(|entry| std::fs::read_to_string(entry.path().join("bot.json")).ok())
            .filter_map(|raw| serde_json::from_str::<Bot>(&raw).ok())
            .filter(|bot| valid_bot_id(&bot.id))
            .collect();
        bots.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.name.cmp(&b.name)));
        bots
    }

    pub async fn list(&self) -> Vec<BotSummary> {
        let mut out = Vec::new();
        for bot in self.list_bots() {
            let chat_id = bot_chat_id(&bot.id);
            let phase = self
                .acp
                .snapshot(&chat_id)
                .await
                .map(|snapshot| snapshot.phase);
            let effective_cwd = self.effective_cwd(&bot).unwrap_or_default();
            out.push(BotSummary {
                bot,
                chat_id,
                effective_cwd,
                phase,
            });
        }
        out
    }

    pub fn get(&self, bot_id: &str) -> AppResult<Bot> {
        let path = self.bot_dir(bot_id)?.join("bot.json");
        let raw = std::fs::read_to_string(&path)
            .map_err(|_| AppError::coded("BOT_NOT_FOUND", format!("Bot not found: {bot_id}")))?;
        serde_json::from_str(&raw)
            .map_err(|error| AppError::from(format!("Corrupt bot file: {error}")))
    }

    /// 按名字（不分大小写）或 id 查找，IM 的 `/to <name>` 用。
    pub fn find(&self, name_or_id: &str) -> Option<Bot> {
        let needle = name_or_id.trim();
        if needle.is_empty() {
            return None;
        }
        let bots = self.list_bots();
        bots.iter()
            .find(|bot| bot.id == needle)
            .or_else(|| {
                bots.iter()
                    .find(|bot| bot.name.trim().eq_ignore_ascii_case(needle))
            })
            .cloned()
    }

    fn write(&self, bot: &Bot) -> AppResult<()> {
        let dir = self.bot_dir(&bot.id)?;
        std::fs::create_dir_all(&dir)
            .map_err(|error| AppError::from(format!("Unable to create bot dir: {error}")))?;
        let raw =
            serde_json::to_string_pretty(bot).map_err(|error| AppError::from(error.to_string()))?;
        let tmp = dir.join("bot.json.tmp");
        std::fs::write(&tmp, raw)
            .and_then(|_| std::fs::rename(&tmp, dir.join("bot.json")))
            .map_err(|error| AppError::from(format!("Unable to write bot: {error}")))
    }

    fn write_home(&self, bot: &Bot) -> AppResult<()> {
        let home = self.home_dir(&bot.id)?;
        std::fs::create_dir_all(&home)
            .map_err(|error| AppError::from(format!("Unable to create bot home: {error}")))?;
        let content = persona_markdown(bot);
        for name in ["CLAUDE.md", "AGENTS.md"] {
            std::fs::write(home.join(name), &content)
                .map_err(|error| AppError::from(format!("Unable to write {name}: {error}")))?;
        }
        Ok(())
    }

    /// 新建（id 为空）或更新。只接受用户可编辑字段；线程 id 与时间戳以磁盘为准。
    /// 改了引擎或工作目录时，旧线程属于别的引擎 / 目录，不能再续接：忘掉线程 id
    /// 并停掉正在跑的会话，下次启动是全新会话。
    pub async fn save(&self, draft: Bot) -> AppResult<Bot> {
        let name = draft.name.trim();
        if name.is_empty() {
            return Err(AppError::coded(
                "BOT_NAME_REQUIRED",
                "Bot name cannot be empty",
            ));
        }
        if name.chars().count() > NAME_MAX {
            return Err(AppError::coded("BOT_NAME_TOO_LONG", "Bot name is too long"));
        }
        if draft.persona.chars().count() > PERSONA_MAX {
            return Err(AppError::coded(
                "BOT_PERSONA_TOO_LONG",
                "Bot persona is too long",
            ));
        }
        if let Some(cwd) = draft
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
        {
            if !Path::new(cwd).is_dir() {
                return Err(AppError::coded_with_params(
                    "BOT_CWD_INVALID",
                    format!("Bot cwd does not exist: {cwd}"),
                    HashMap::from([("cwd".to_string(), cwd.to_string())]),
                ));
            }
        }
        engine_spec(&self.app_paths, &draft.engine_id)?;
        let is_new = draft.id.trim().is_empty();
        let lock = (!is_new).then(|| self.lifecycle_lock(draft.id.trim()));
        let _guard = match &lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        let now = Utc::now().timestamp_millis();
        let mut reset_thread = false;
        let mut bot = if is_new {
            Bot {
                id: Uuid::new_v4().to_string(),
                created_at: now,
                acp_session_id: None,
                ..draft.clone()
            }
        } else {
            let existing = self.get(&draft.id)?;
            reset_thread = thread_identity_changed(&existing, &draft);
            Bot {
                id: existing.id.clone(),
                created_at: existing.created_at,
                acp_session_id: existing.acp_session_id.clone(),
                ..draft.clone()
            }
        };
        bot.name = name.to_string();
        bot.cwd = bot
            .cwd
            .map(|cwd| cwd.trim().to_string())
            .filter(|cwd| !cwd.is_empty());
        bot.updated_at = now;
        if reset_thread {
            bot.acp_session_id = None;
            self.stop_chat(&bot_chat_id(&bot.id)).await;
            info!(bot = %bot.id, "bot engine or cwd changed; thread reset");
        }
        self.write(&bot)?;
        // 家目录总是建好（换回家目录模式时人设立刻生效）。
        self.write_home(&bot)?;
        Ok(bot)
    }

    pub async fn delete(&self, bot_id: &str) -> AppResult<()> {
        let dir = self.bot_dir(bot_id)?;
        let chat_id = bot_chat_id(bot_id);
        // 先取消进行中的回合，再拿生命周期锁（锁不跨回合，不会被长回合挡住）。
        let _ = self.acp.cancel(&chat_id).await;
        let lock = self.lifecycle_lock(bot_id);
        let _guard = lock.lock().await;
        self.stop_chat(&chat_id).await;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|error| AppError::from(format!("Unable to delete bot: {error}")))?;
        }
        Ok(())
    }

    /// 开新话题：停掉当前进程并忘掉线程 id，下次启动是全新会话。
    pub async fn new_thread(&self, bot_id: &str) -> AppResult<Bot> {
        let chat_id = bot_chat_id(bot_id);
        self.get(bot_id)?;
        let _ = self.acp.cancel(&chat_id).await;
        let lock = self.lifecycle_lock(bot_id);
        let _guard = lock.lock().await;
        let mut bot = self.get(bot_id)?;
        self.stop_chat(&chat_id).await;
        bot.acp_session_id = None;
        bot.updated_at = Utc::now().timestamp_millis();
        self.write(&bot)?;
        Ok(bot)
    }

    /// 确保 Bot 的会话在跑：已在跑就直接返回快照，否则按记住的线程续接。
    pub async fn ensure_started(
        &self,
        app: &AppHandle,
        bot_id: &str,
    ) -> AppResult<AcpChatSnapshot> {
        // 已在跑（含回合进行中）直接返回，不排任何锁。
        if let Some(snapshot) = self.live_snapshot(bot_id).await {
            return Ok(snapshot);
        }
        let lock = self.lifecycle_lock(bot_id);
        let _guard = lock.lock().await;
        self.ensure_started_locked(app, bot_id).await
    }

    async fn live_snapshot(&self, bot_id: &str) -> Option<AcpChatSnapshot> {
        self.acp
            .snapshot(&bot_chat_id(bot_id))
            .await
            .filter(|snapshot| {
                !matches!(snapshot.phase, AcpChatPhase::Exited | AcpChatPhase::Failed)
            })
    }

    async fn ensure_started_locked(
        &self,
        app: &AppHandle,
        bot_id: &str,
    ) -> AppResult<AcpChatSnapshot> {
        let chat_id = bot_chat_id(bot_id);
        if let Some(snapshot) = self.live_snapshot(bot_id).await {
            return Ok(snapshot);
        }
        let mut bot = self.get(bot_id)?;
        let cwd = self.effective_cwd(&bot)?;
        if bot.cwd.is_none() {
            self.write_home(&bot)?;
        }
        let engine = engine_spec(&self.app_paths, &bot.engine_id)?;
        let mut spec = tauri::async_runtime::spawn_blocking({
            let cwd = cwd.clone();
            move || resolve_engine_launch(&engine, &cwd)
        })
        .await
        .map_err(|error| AppError::from(error.to_string()))??;
        spec.mcp_servers = ccpanes_mcp_servers(&self.app_paths);
        spec.resume_acp_session_id = bot.acp_session_id.clone();
        spec.auto_approve_kinds = bot.auto_approve_kinds.clone();
        let requested = bot.acp_session_id.clone();
        let snapshot = self.acp.start(app.clone(), chat_id.clone(), spec).await?;

        let fresh = requested.is_none() || snapshot.acp_session_id != requested;
        if fresh {
            if bot.cwd.is_some() {
                self.acp
                    .set_next_prompt_preamble(&chat_id, persona_preamble(&bot));
            }
            if let Some(id) = snapshot.acp_session_id.clone() {
                // 历史列表里显示 Bot 名（user 来源，agent 标题不会覆盖）。
                let _ = self.acp.rename_chat_history(&id, &bot.name);
                bot.acp_session_id = Some(id);
                bot.updated_at = Utc::now().timestamp_millis();
                self.write(&bot)?;
                emit_changed(app);
            }
        }
        info!(bot = %bot.id, fresh, "bot chat started");
        Ok(snapshot)
    }

    /// 外部提交（IM）：排队等前一轮结束，发出后等回合结束，返回助手回复文本。
    ///
    /// `prompt_id` 进 `external_prompt` 公告的载荷，调用方（IM 入站）据此认出
    /// 「本条消息这一轮」的事件。
    pub async fn submit_external(
        self: &Arc<Self>,
        app: &AppHandle,
        bot_id: &str,
        prompt_id: &str,
        text: &str,
        origin: BotMessageOrigin,
    ) -> AppResult<String> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AppError::coded(
                "ACP_PROMPT_REQUIRED",
                "Message cannot be empty",
            ));
        }
        let queue = self.queue_lock(bot_id);
        let _queued = queue.lock().await;
        self.ensure_started(app, bot_id).await?;
        let chat_id = bot_chat_id(bot_id);
        // 先订阅再提交：按 chat 的无界队列，整轮事件一个不丢。
        let mut events = self.acp.subscribe_chat(&chat_id);
        let announce = PromptAnnouncement {
            kind: EXTERNAL_PROMPT_EVENT_KIND.to_string(),
            payload: json!({"text": text, "origin": origin, "promptId": prompt_id}),
        };
        let stop_reason = self.run_external_turn(&chat_id, text, announce).await?;
        let mut collected = Vec::new();
        while let Ok(event) = events.try_recv() {
            collected.push(event);
        }
        let reply = collect_reply_text(&chat_id, prompt_id, collected.iter());
        if reply.is_empty() && stop_reason == "cancelled" {
            return Ok("（已取消）".to_string());
        }
        Ok(reply)
    }

    /// 等会话空闲并原子地占到回合（界面里抢先发的那条先跑，这条继续等），
    /// 占到后再计回合超时。
    async fn run_external_turn(
        self: &Arc<Self>,
        chat_id: &str,
        text: &str,
        announce: PromptAnnouncement,
    ) -> AppResult<String> {
        let deadline = tokio::time::Instant::now() + WAIT_READY_TIMEOUT;
        loop {
            match self.chat_phase(chat_id).await {
                Some(AcpChatPhase::Ready) => {
                    let blocks = vec![json!({"type": "text", "text": text})];
                    let turn =
                        self.acp
                            .prompt_and_wait_announced(chat_id, blocks, Some(announce.clone()));
                    match tokio::time::timeout(TURN_TIMEOUT, turn).await {
                        Ok(Err(error)) if error.code() == Some("ACP_TURN_IN_PROGRESS") => {}
                        Ok(result) => return result,
                        Err(_) => {
                            let _ = self.acp.cancel(chat_id).await;
                            return Err(AppError::coded("BOT_TURN_TIMEOUT", "Bot reply timed out"));
                        }
                    }
                }
                Some(AcpChatPhase::Starting | AcpChatPhase::Generating) => {}
                _ => {
                    return Err(AppError::coded(
                        "ACP_SESSION_NOT_READY",
                        "Bot session is not running",
                    ))
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AppError::coded(
                    "BOT_BUSY",
                    "Bot is still busy with a previous turn",
                ));
            }
            tokio::time::sleep(WAIT_READY_POLL).await;
        }
    }

    pub async fn cancel(&self, bot_id: &str) -> AppResult<()> {
        self.acp.cancel(&bot_chat_id(bot_id)).await
    }
}

fn lock_in(
    locks: &std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    bot_id: &str,
) -> Arc<Mutex<()>> {
    locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(bot_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn normalized_cwd(cwd: Option<&str>) -> Option<&str> {
    cwd.map(str::trim).filter(|cwd| !cwd.is_empty())
}

/// 引擎或工作目录变了 = 线程身份变了（旧线程不能在新引擎 / 新目录下续接）。
fn thread_identity_changed(existing: &Bot, draft: &Bot) -> bool {
    existing.engine_id.trim() != draft.engine_id.trim()
        || normalized_cwd(existing.cwd.as_deref()) != normalized_cwd(draft.cwd.as_deref())
}

pub fn emit_changed(app: &AppHandle) {
    if crate::webview_reliability::webview_emits_allowed() {
        let _ = app.emit(BOTS_CHANGED_EVENT, Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(chat_id: &str, kind: &str, payload: Value) -> AcpChatEvent {
        AcpChatEvent {
            chat_id: chat_id.into(),
            kind: kind.into(),
            payload,
        }
    }

    fn chunk(chat_id: &str, text: &str) -> AcpChatEvent {
        event(
            chat_id,
            "update",
            json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}),
        )
    }

    fn bot(name: &str, persona: &str) -> Bot {
        Bot {
            id: "b1".into(),
            name: name.into(),
            avatar: String::new(),
            color: String::new(),
            persona: persona.into(),
            engine_id: "claude".into(),
            cwd: None,
            auto_approve_kinds: vec![],
            acp_session_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn reply_joins_main_agent_chunks_until_turn_end() {
        let events = vec![
            // 排队期间界面里那一轮的输出，以及别的 IM 消息的公告：都不算。
            chunk("bot-a", "desktop turn"),
            event("bot-a", "turn_ended", json!({"stopReason": "end_turn"})),
            event(
                "bot-a",
                EXTERNAL_PROMPT_EVENT_KIND,
                json!({"text": "x", "promptId": "p0"}),
            ),
            event(
                "bot-a",
                EXTERNAL_PROMPT_EVENT_KIND,
                json!({"text": "hi", "promptId": "p1"}),
            ),
            chunk("bot-a", "Hel"),
            chunk("bot-other", "noise"),
            event(
                "bot-a",
                "update",
                json!({"update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}}),
            ),
            event(
                "bot-a",
                "update",
                json!({"update": {"sessionUpdate": "agent_message_chunk", "_meta": {"claudeCode": {"parentToolUseId": "t1"}}, "content": {"type": "text", "text": "sub"}}}),
            ),
            chunk("bot-a", "lo "),
            event("bot-a", "turn_ended", json!({"stopReason": "end_turn"})),
            chunk("bot-a", "next turn"),
        ];
        assert_eq!(collect_reply_text("bot-a", "p1", events.iter()), "Hello");
    }

    #[test]
    fn reply_empty_without_chunks() {
        let events = [
            event(
                "bot-a",
                EXTERNAL_PROMPT_EVENT_KIND,
                json!({"promptId": "p"}),
            ),
            event("bot-a", "turn_ended", json!({})),
        ];
        assert_eq!(collect_reply_text("bot-a", "p", events.iter()), "");
        // 没见到本条公告（例如被拒绝）就什么都不收。
        let events = [chunk("bot-a", "other turn")];
        assert_eq!(collect_reply_text("bot-a", "p", events.iter()), "");
    }

    #[test]
    fn engine_or_cwd_change_resets_the_thread() {
        let base = bot("a", "");
        let mut same = base.clone();
        same.persona = "new persona".into();
        same.cwd = Some("  ".into());
        assert!(!thread_identity_changed(&base, &same));
        let mut engine = base.clone();
        engine.engine_id = "codex".into();
        assert!(thread_identity_changed(&base, &engine));
        let mut cwd = base.clone();
        cwd.cwd = Some("/repo".into());
        assert!(thread_identity_changed(&base, &cwd));
        let mut trimmed = cwd.clone();
        trimmed.cwd = Some(" /repo ".into());
        assert!(!thread_identity_changed(&cwd, &trimmed));
    }

    #[test]
    fn persona_markdown_falls_back_to_default() {
        let md = persona_markdown(&bot("小助", "  "));
        assert!(md.starts_with("# 小助"));
        assert!(md.contains("乐于助人"));
        let md = persona_markdown(&bot("Rev", "You review PRs."));
        assert!(md.contains("You review PRs."));
    }

    #[test]
    fn preamble_only_when_persona_present() {
        assert!(persona_preamble(&bot("a", "")).is_none());
        let text = persona_preamble(&bot("a", "be terse")).unwrap();
        assert!(text.contains("be terse"));
    }

    #[test]
    fn bot_ids_are_path_safe() {
        assert!(valid_bot_id("8b0c-1_a"));
        assert!(!valid_bot_id("../etc"));
        assert!(!valid_bot_id(""));
        assert_eq!(bot_chat_id("x"), "bot-x");
    }

    fn service() -> (tempfile::TempDir, BotService) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().to_string_lossy().into_owned();
        let acp = Arc::new(AcpChatService::new(temp.path().join("agent-chats")));
        let service = BotService::new(
            temp.path().join("bots"),
            acp,
            Arc::new(AppPaths::new(Some(data))),
        );
        (temp, service)
    }

    /// IM 长回合持有的是队列锁；开新话题 / 删除只要生命周期锁，不被挡住。
    #[tokio::test]
    async fn long_im_turn_does_not_block_new_thread_or_delete() {
        let (_temp, service) = service();
        let mut b = bot("a", "");
        b.id = "b1".into();
        b.acp_session_id = Some("old-thread".into());
        service.write(&b).unwrap();
        let queue = service.queue_lock("b1");
        let _turn = queue.lock().await;
        let fresh = tokio::time::timeout(Duration::from_secs(5), service.new_thread("b1"))
            .await
            .expect("new_thread must not wait for the IM queue")
            .unwrap();
        assert!(fresh.acp_session_id.is_none());
        tokio::time::timeout(Duration::from_secs(5), service.delete("b1"))
            .await
            .expect("delete must not wait for the IM queue")
            .unwrap();
        assert!(service.get("b1").is_err());
    }

    #[test]
    fn bot_json_tolerates_missing_optional_fields() {
        let parsed: Bot =
            serde_json::from_str(r#"{"id":"a","name":"n","engineId":"claude"}"#).unwrap();
        assert!(parsed.cwd.is_none());
        assert!(parsed.auto_approve_kinds.is_empty());
    }
}
