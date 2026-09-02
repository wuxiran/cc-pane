//! Automations：定时把 prompt 派给 ACP agent（docs/55 H1 最小版落地）。
//!
//! 形态对齐 Orca Automations 的核心（cron 日程 + 错过宽限 + 运行历史），
//! 但派发目标是 **ACP headless 会话**——不开标签、不占 PTY，到点起一个
//! 无人值守 chat 会话灌 prompt，回合结束记录 stopReason 后回收。agent 经
//! 注入的 ccpanes MCP 想开终端/派工都能自己来，因此不需要 Orca 那种
//! 「无窗口则 skip」的限制。明确不做（判定沿用 docs/55 H1）：外部 cron
//! 管理器聚合、事件规则引擎、自动重试链。
//!
//! 存储走文件（与 launch profiles / agent-chats meta 同一先例，避免 DB
//! migration）：`<data>/automations/defs/<id>.json` + `runs/<id>.jsonl`。

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use crate::commands::{ccpanes_mcp_servers, engine_spec, resolve_engine_launch};
use crate::services::AcpChatService;
use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::AppPaths;

pub const AUTOMATIONS_CHANGED_EVENT: &str = "automations-changed";

/// 调度 tick 周期。cron 的最小粒度是分钟，30s 足够且撞不上边界抖动。
const TICK_INTERVAL: Duration = Duration::from_secs(30);
const RUNS_KEEP: usize = 50;
const DEFAULT_GRACE_MINUTES: u32 = 10;
const DEFAULT_TIMEOUT_MINUTES: u32 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDef {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// agent 的工作目录（必须存在，spawn 前校验——portable-pty HOME 回退
    /// 同族坑）。
    pub cwd: String,
    /// 所属工作空间（docs/98 workspace-first）：UI 按它分组、在其项目里选 cwd。
    /// 旧定义缺省为 None；物理存储仍是单一目录，调度器只需一处扫。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    /// ACP 引擎 id（内置或 engines.json 自定义）。
    pub engine_id: String,
    /// 5 字段 cron（分 时 日 月 周）。
    pub schedule: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_grace")]
    pub grace_minutes: u32,
    #[serde(default = "default_timeout")]
    pub timeout_minutes: u32,
    #[serde(default = "default_true")]
    pub auto_approve: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 下一次到期时间（unix millis）。保存/错过/派发后前移。
    #[serde(default)]
    pub next_run_at: Option<i64>,
}

fn default_true() -> bool {
    true
}
fn default_grace() -> u32 {
    DEFAULT_GRACE_MINUTES
}
fn default_timeout() -> u32 {
    DEFAULT_TIMEOUT_MINUTES
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub scheduled_for: i64,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// completed | failed | skipped_missed | skipped_overlap
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 5 字段 cron → 下一次到期（unix millis）。`cron` crate 是 6/7 字段
/// （带秒），统一前置 "0 "。
pub fn next_occurrence_millis(schedule: &str, after: DateTime<Local>) -> AppResult<i64> {
    let normalized = format!("0 {}", schedule.trim());
    let parsed = cron::Schedule::from_str(&normalized).map_err(|error| {
        AppError::coded(
            "AUTOMATION_BAD_SCHEDULE",
            format!("Invalid cron schedule '{schedule}': {error}"),
        )
    })?;
    parsed
        .after(&after)
        .next()
        .map(|next| next.timestamp_millis())
        .ok_or_else(|| {
            AppError::coded(
                "AUTOMATION_BAD_SCHEDULE",
                format!("Cron schedule '{schedule}' has no future occurrence"),
            )
        })
}

/// 一次 tick 对单个定义的裁决（纯函数，可测）。
#[derive(Debug, PartialEq, Eq)]
pub enum TickAction {
    /// 未到期或未启用。
    Wait,
    /// 到期且在宽限内：派发。
    Dispatch { scheduled_for: i64 },
    /// 超宽限：记 skipped_missed 并前移。
    SkipMissed { scheduled_for: i64 },
}

pub fn plan_tick(def: &AutomationDef, now_millis: i64) -> TickAction {
    if !def.enabled {
        return TickAction::Wait;
    }
    let Some(next_run_at) = def.next_run_at else {
        return TickAction::Wait;
    };
    if now_millis < next_run_at {
        return TickAction::Wait;
    }
    let grace_millis = i64::from(def.grace_minutes) * 60_000;
    if now_millis - next_run_at <= grace_millis {
        TickAction::Dispatch {
            scheduled_for: next_run_at,
        }
    } else {
        TickAction::SkipMissed {
            scheduled_for: next_run_at,
        }
    }
}

pub struct AutomationService {
    dir: PathBuf,
    acp: Arc<AcpChatService>,
    app_paths: Arc<AppPaths>,
    /// 正在派发中的 automation id：同一定义不重叠执行。
    in_flight: Mutex<HashSet<String>>,
}

impl AutomationService {
    pub fn new(dir: PathBuf, acp: Arc<AcpChatService>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            dir,
            acp,
            app_paths,
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    fn defs_dir(&self) -> PathBuf {
        self.dir.join("defs")
    }

    fn runs_path(&self, automation_id: &str) -> PathBuf {
        self.dir.join("runs").join(format!("{automation_id}.jsonl"))
    }

    pub fn list(&self) -> Vec<AutomationDef> {
        let Ok(entries) = std::fs::read_dir(self.defs_dir()) else {
            return Vec::new();
        };
        let mut defs: Vec<AutomationDef> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .filter_map(|raw| serde_json::from_str::<AutomationDef>(&raw).ok())
            .collect();
        defs.sort_by_key(|def| std::cmp::Reverse(def.updated_at));
        defs
    }

    pub fn save(&self, mut def: AutomationDef) -> AppResult<AutomationDef> {
        if def.name.trim().is_empty() {
            return Err(AppError::coded(
                "AUTOMATION_NAME_REQUIRED",
                "Automation name cannot be empty",
            ));
        }
        if def.prompt.trim().is_empty() {
            return Err(AppError::coded(
                "AUTOMATION_PROMPT_REQUIRED",
                "Automation prompt cannot be empty",
            ));
        }
        if !std::path::Path::new(&def.cwd).is_dir() {
            return Err(AppError::coded(
                "AUTOMATION_CWD_INVALID",
                format!("Automation cwd does not exist: {}", def.cwd),
            ));
        }
        // 引擎必须能解析（提前失败，不等到点才发现没装）。
        engine_spec(&self.app_paths, &def.engine_id)?;
        let now = unix_millis();
        if def.id.trim().is_empty() {
            def.id = Uuid::new_v4().to_string();
            def.created_at = now;
        }
        def.updated_at = now;
        // 校验 cron 并计算下一次到期。
        def.next_run_at = Some(next_occurrence_millis(&def.schedule, Local::now())?);
        self.write_def(&def)?;
        Ok(def)
    }

    pub fn delete(&self, automation_id: &str) -> AppResult<()> {
        let path = self.def_path(automation_id)?;
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| AppError::from(format!("Unable to delete automation: {error}")))?;
        }
        let _ = std::fs::remove_file(self.runs_path(automation_id));
        Ok(())
    }

    pub fn runs(&self, automation_id: &str) -> Vec<AutomationRun> {
        let Ok(raw) = std::fs::read_to_string(self.runs_path(automation_id)) else {
            return Vec::new();
        };
        let mut runs: Vec<AutomationRun> = raw
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        runs.reverse();
        runs.truncate(RUNS_KEEP);
        runs
    }

    fn def_path(&self, automation_id: &str) -> AppResult<PathBuf> {
        let id = automation_id.trim();
        let safe = !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !safe {
            return Err(AppError::coded(
                "AUTOMATION_BAD_ID",
                "Automation id is invalid",
            ));
        }
        Ok(self.defs_dir().join(format!("{id}.json")))
    }

    fn write_def(&self, def: &AutomationDef) -> AppResult<()> {
        let path = self.def_path(&def.id)?;
        std::fs::create_dir_all(self.defs_dir()).map_err(|error| {
            AppError::from(format!("Unable to create automations dir: {error}"))
        })?;
        let raw =
            serde_json::to_string_pretty(def).map_err(|error| AppError::from(error.to_string()))?;
        std::fs::write(&path, raw)
            .map_err(|error| AppError::from(format!("Unable to write automation: {error}")))
    }

    fn append_run(&self, run: &AutomationRun) {
        let path = self.runs_path(&run.automation_id);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(line) = serde_json::to_string(run) {
            use std::io::Write as _;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = writeln!(file, "{line}");
            }
        }
    }

    fn emit_changed(&self, app: &AppHandle) {
        if !crate::webview_reliability::webview_emits_allowed() {
            return;
        }
        let _ = app.emit(AUTOMATIONS_CHANGED_EVENT, json!({}));
    }

    /// 启动调度循环（setup 阶段调用一次）。
    pub fn start_scheduler(self: &Arc<Self>, app: AppHandle) {
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                service.tick(&app).await;
            }
        });
    }

    async fn tick(self: &Arc<Self>, app: &AppHandle) {
        let now = unix_millis();
        for def in self.list() {
            match plan_tick(&def, now) {
                TickAction::Wait => {}
                TickAction::SkipMissed { scheduled_for } => {
                    self.append_run(&AutomationRun {
                        id: Uuid::new_v4().to_string(),
                        automation_id: def.id.clone(),
                        scheduled_for,
                        started_at: now,
                        finished_at: Some(now),
                        status: "skipped_missed".to_string(),
                        stop_reason: None,
                        detail: Some(format!("missed by more than {} minutes", def.grace_minutes)),
                    });
                    self.advance_schedule(def, app);
                }
                TickAction::Dispatch { scheduled_for } => {
                    let def_for_dispatch = def.clone();
                    self.advance_schedule(def, app);
                    self.dispatch(app.clone(), def_for_dispatch, scheduled_for, false)
                        .await;
                }
            }
        }
    }

    /// 前移 next_run_at 到下一个 occurrence 并落盘。
    fn advance_schedule(&self, mut def: AutomationDef, app: &AppHandle) {
        match next_occurrence_millis(&def.schedule, Local::now()) {
            Ok(next) => def.next_run_at = Some(next),
            Err(error) => {
                warn!(automation = %def.id, error = %error, "automation schedule became invalid");
                def.next_run_at = None;
                def.enabled = false;
            }
        }
        if let Err(error) = self.write_def(&def) {
            warn!(automation = %def.id, error = %error, "failed to persist automation schedule");
        }
        self.emit_changed(app);
    }

    /// 手动「立即运行」。
    pub async fn run_now(self: &Arc<Self>, app: AppHandle, automation_id: &str) -> AppResult<()> {
        let def = self
            .list()
            .into_iter()
            .find(|def| def.id == automation_id)
            .ok_or_else(|| AppError::coded("AUTOMATION_NOT_FOUND", "Automation was not found"))?;
        let scheduled_for = unix_millis();
        self.dispatch(app, def, scheduled_for, true).await;
        Ok(())
    }

    /// 派发一次运行：headless ACP 会话 → prompt_and_wait → 记录 → 回收。
    /// 同一定义不重叠（上一次还没跑完则记 skipped_overlap）。
    async fn dispatch(
        self: &Arc<Self>,
        app: AppHandle,
        def: AutomationDef,
        scheduled_for: i64,
        manual: bool,
    ) {
        {
            let mut in_flight = self.in_flight.lock().await;
            if !in_flight.insert(def.id.clone()) {
                self.append_run(&AutomationRun {
                    id: Uuid::new_v4().to_string(),
                    automation_id: def.id.clone(),
                    scheduled_for,
                    started_at: unix_millis(),
                    finished_at: Some(unix_millis()),
                    status: "skipped_overlap".to_string(),
                    stop_reason: None,
                    detail: Some("previous run is still in flight".to_string()),
                });
                self.emit_changed(&app);
                return;
            }
        }

        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let started_at = unix_millis();
            info!(automation = %def.id, manual, "automation dispatch begin");
            let result = service.execute(&app, &def).await;
            let finished_at = unix_millis();
            let run = match result {
                Ok(stop_reason) => AutomationRun {
                    id: Uuid::new_v4().to_string(),
                    automation_id: def.id.clone(),
                    scheduled_for,
                    started_at,
                    finished_at: Some(finished_at),
                    status: "completed".to_string(),
                    stop_reason: Some(stop_reason),
                    detail: None,
                },
                Err(error) => AutomationRun {
                    id: Uuid::new_v4().to_string(),
                    automation_id: def.id.clone(),
                    scheduled_for,
                    started_at,
                    finished_at: Some(finished_at),
                    status: "failed".to_string(),
                    stop_reason: None,
                    detail: Some(error.to_string()),
                },
            };
            service.append_run(&run);
            service.in_flight.lock().await.remove(&def.id);
            service.emit_changed(&app);
            info!(automation = %def.id, status = %run.status, "automation dispatch end");
        });
    }

    async fn execute(&self, app: &AppHandle, def: &AutomationDef) -> AppResult<String> {
        let engine = engine_spec(&self.app_paths, &def.engine_id)?;
        let mut spec = resolve_engine_launch(&engine, &def.cwd)?;
        spec.mcp_servers = ccpanes_mcp_servers(&self.app_paths);
        if def.auto_approve {
            spec.auto_approve_kinds = vec![crate::services::AUTO_APPROVE_ALL.to_string()];
        }
        let chat_id = format!("auto-{}-{}", def.id, unix_millis());

        self.acp.start(app.clone(), chat_id.clone(), spec).await?;
        let timeout = Duration::from_secs(u64::from(def.timeout_minutes.max(1)) * 60);
        let turn = tokio::time::timeout(
            timeout,
            self.acp
                .prompt_and_wait(&chat_id, vec![json!({"type": "text", "text": def.prompt})]),
        )
        .await;
        let outcome = match turn {
            Ok(result) => result,
            Err(_) => Err(AppError::coded(
                "AUTOMATION_TIMEOUT",
                format!("Run exceeded {} minutes", def.timeout_minutes),
            )),
        };
        // 无论成败都回收 headless 会话，不留孤儿 adapter。
        if let Err(error) = self.acp.stop(&chat_id).await {
            warn!(automation = %def.id, error = %error, "failed to stop automation chat session");
        }
        outcome
    }
}

fn unix_millis() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(enabled: bool, next_run_at: Option<i64>, grace_minutes: u32) -> AutomationDef {
        AutomationDef {
            id: "a".into(),
            name: "n".into(),
            prompt: "p".into(),
            cwd: ".".into(),
            workspace_name: None,
            engine_id: "claude".into(),
            schedule: "0 9 * * *".into(),
            enabled,
            grace_minutes,
            timeout_minutes: 30,
            auto_approve: true,
            created_at: 0,
            updated_at: 0,
            next_run_at,
        }
    }

    #[test]
    fn plan_tick_waits_until_due() {
        assert_eq!(
            plan_tick(&def(true, Some(1_000), 10), 999),
            TickAction::Wait
        );
        assert_eq!(
            plan_tick(&def(false, Some(1_000), 10), 2_000),
            TickAction::Wait
        );
        assert_eq!(plan_tick(&def(true, None, 10), 2_000), TickAction::Wait);
    }

    #[test]
    fn plan_tick_dispatches_within_grace() {
        let action = plan_tick(&def(true, Some(1_000), 10), 1_000 + 9 * 60_000);
        assert_eq!(
            action,
            TickAction::Dispatch {
                scheduled_for: 1_000
            }
        );
    }

    #[test]
    fn plan_tick_skips_beyond_grace() {
        let action = plan_tick(&def(true, Some(1_000), 10), 1_000 + 11 * 60_000);
        assert_eq!(
            action,
            TickAction::SkipMissed {
                scheduled_for: 1_000
            }
        );
    }

    #[test]
    fn next_occurrence_parses_five_field_cron() {
        let now = Local::now();
        let next = next_occurrence_millis("*/5 * * * *", now).expect("next occurrence");
        assert!(next > now.timestamp_millis());
        assert!(next <= now.timestamp_millis() + 5 * 60_000 + 1_000);
    }

    #[test]
    fn next_occurrence_rejects_garbage() {
        assert!(next_occurrence_millis("not a cron", Local::now()).is_err());
    }
}
