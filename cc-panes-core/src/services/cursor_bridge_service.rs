//! Cursor Bridge 登记簿：持续会话、范围冻结、requestId 幂等。
//!
//! 每次操作从磁盘读、改、原子写。未知 schemaVersion 拒绝且不覆盖。

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use crate::models::cursor_bridge::{
    CursorBridgeModelPref, CursorBridgeModelPreferences, CursorBridgeModelTarget,
    CursorBridgeRegistry, CursorBridgeScope, CursorBridgeSession, CursorBridgeSessionControl,
    CursorBridgeSessionMode, CursorBridgeSessionStatus, CursorBridgeTurnPlan,
    CursorBridgeWorkspaceBinding, CURSOR_BRIDGE_SCHEMA_VERSION, CURSOR_BRIDGE_SESSION_PREFIX,
    CURSOR_BRIDGE_TASK_PREFIX,
};
use crate::services::cursor_bridge_prompts::{build_context_prompt, build_do_prompt};
use crate::utils::atomic_file::write_atomic;
use crate::utils::error::{AppError, AppResult};
use crate::utils::error_codes;
use crate::utils::project_identity::canonical_project_path;

const SESSIONS_FILE: &str = "sessions-v1.json";
const WORKSPACE_FILE: &str = "workspace-v1.json";
const MODELS_FILE: &str = "models-v1.json";

#[derive(Debug, Clone)]
pub struct CursorBridgeCreateSpec {
    pub workspace: String,
    pub runtime_kind: Option<String>,
    pub read_only: bool,
    pub allowed_paths: Vec<String>,
    pub request_id: Option<String>,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub task: String,
    pub print: bool,
}

pub struct CursorBridgeService {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl CursorBridgeService {
    pub fn open(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn init_workspace(&self, project_path: &str) -> AppResult<CursorBridgeWorkspaceBinding> {
        let _guard = self.lock.lock();
        let path = require_absolute_path(project_path)?;
        let binding = CursorBridgeWorkspaceBinding {
            schema_version: CURSOR_BRIDGE_SCHEMA_VERSION,
            project_path: path,
        };
        self.write_json(&self.dir.join(WORKSPACE_FILE), &binding)?;
        Ok(binding)
    }

    pub fn workspace_binding(&self) -> AppResult<Option<CursorBridgeWorkspaceBinding>> {
        let _guard = self.lock.lock();
        load_optional_json(&self.dir.join(WORKSPACE_FILE))
    }

    pub fn model_preferences(&self) -> AppResult<CursorBridgeModelPreferences> {
        let _guard = self.lock.lock();
        Ok(load_optional_json(&self.dir.join(MODELS_FILE))?.unwrap_or_default())
    }

    pub fn set_model_preferences(
        &self,
        target: CursorBridgeModelTarget,
        pref: CursorBridgeModelPref,
    ) -> AppResult<CursorBridgeModelPreferences> {
        let _guard = self.lock.lock();
        let mut current: CursorBridgeModelPreferences =
            load_optional_json(&self.dir.join(MODELS_FILE))?.unwrap_or_default();
        match target {
            CursorBridgeModelTarget::Context => current.context = pref,
            CursorBridgeModelTarget::Do => current.do_pref = pref,
            CursorBridgeModelTarget::Both => {
                current.context = pref.clone();
                current.do_pref = pref;
            }
        }
        current.schema_version = CURSOR_BRIDGE_SCHEMA_VERSION;
        self.write_json(&self.dir.join(MODELS_FILE), &current)?;
        Ok(current)
    }

    pub fn reset_model_preferences(
        &self,
        target: CursorBridgeModelTarget,
    ) -> AppResult<CursorBridgeModelPreferences> {
        self.set_model_preferences(target, CursorBridgeModelPref::default())
    }

    pub fn plan_context(&self, query: &str, workspace: &str) -> AppResult<CursorBridgeTurnPlan> {
        let query = require_non_empty(query, error_codes::CURSOR_BRIDGE_QUERY_REQUIRED)?;
        let workspace = require_absolute_path(workspace)?;
        let prefs = self.model_preferences()?;
        Ok(CursorBridgeTurnPlan {
            session_id: None,
            task_id: new_id(CURSOR_BRIDGE_TASK_PREFIX),
            prompt: build_context_prompt(query),
            print: true,
            read_only: true,
            resume_chat_id: None,
            model_id: prefs.context.model_id,
            effort: prefs.context.effort,
            replay: false,
            workspace,
            runtime_kind: None,
        })
    }

    pub fn plan_do(
        &self,
        mode: CursorBridgeSessionMode,
        spec: CursorBridgeCreateSpec,
        session_id: Option<&str>,
    ) -> AppResult<CursorBridgeTurnPlan> {
        let _guard = self.lock.lock();
        match mode {
            CursorBridgeSessionMode::Isolated => plan_isolated(spec),
            CursorBridgeSessionMode::Create => self.plan_create(spec),
            CursorBridgeSessionMode::Continue => {
                let session_id = session_id.ok_or_else(|| {
                    AppError::coded(
                        error_codes::CURSOR_BRIDGE_SESSION_ID_REQUIRED,
                        "sessionMode=continue requires sessionId",
                    )
                })?;
                self.plan_continue(session_id, spec)
            }
        }
    }

    pub fn attach_launch(
        &self,
        session_id: &str,
        launch_id: &str,
        pty_session_id: &str,
    ) -> AppResult<CursorBridgeSession> {
        self.mutate_session(session_id, |session| {
            session.launch_id = Some(launch_id.to_string());
            session.pty_session_id = Some(pty_session_id.to_string());
            session.status = CursorBridgeSessionStatus::Busy;
        })
    }

    pub fn bind_resume_chat_id(
        &self,
        launch_id: &str,
        resume_chat_id: &str,
    ) -> AppResult<Option<CursorBridgeSession>> {
        let launch_id = launch_id.trim();
        let resume_chat_id = resume_chat_id.trim();
        if launch_id.is_empty() || resume_chat_id.is_empty() {
            return Ok(None);
        }
        let _guard = self.lock.lock();
        let mut registry = self.load_registry()?;
        let Some(session) = registry
            .sessions
            .iter_mut()
            .find(|session| session.launch_id.as_deref() == Some(launch_id))
        else {
            return Ok(None);
        };
        session.resume_chat_id = Some(resume_chat_id.to_string());
        if session.status == CursorBridgeSessionStatus::Creating
            || session.status == CursorBridgeSessionStatus::Busy
        {
            session.status = CursorBridgeSessionStatus::Ready;
        }
        let snapshot = session.clone();
        self.write_json(&self.sessions_path(), &registry)?;
        Ok(Some(snapshot))
    }

    pub fn mark_ready(&self, session_id: &str) -> AppResult<CursorBridgeSession> {
        self.mutate_session(session_id, |session| {
            if session.status != CursorBridgeSessionStatus::Closed {
                session.status = CursorBridgeSessionStatus::Ready;
            }
        })
    }

    pub fn mark_needs_attention(&self, session_id: &str) -> AppResult<CursorBridgeSession> {
        self.mutate_session(session_id, |session| {
            if session.status != CursorBridgeSessionStatus::Closed {
                session.status = CursorBridgeSessionStatus::NeedsAttention;
            }
        })
    }

    pub fn get_session(&self, session_id: &str) -> AppResult<CursorBridgeSession> {
        let _guard = self.lock.lock();
        let registry = self.load_registry()?;
        find_session(&registry, session_id).cloned()
    }

    pub fn list_sessions(&self) -> AppResult<Vec<CursorBridgeSession>> {
        let _guard = self.lock.lock();
        Ok(self.load_registry()?.sessions)
    }

    pub fn control_session(
        &self,
        session_id: &str,
        action: CursorBridgeSessionControl,
        confirm: bool,
    ) -> AppResult<Option<CursorBridgeSession>> {
        match action {
            CursorBridgeSessionControl::Close => {
                let session = self.mutate_session(session_id, |session| {
                    session.status = CursorBridgeSessionStatus::Closed;
                    session.pty_session_id = None;
                })?;
                Ok(Some(session))
            }
            CursorBridgeSessionControl::Reconcile => {
                let session = self.get_session(session_id)?;
                if session.resume_chat_id.is_none() {
                    return Ok(Some(self.mark_needs_attention(session_id)?));
                }
                Ok(Some(self.mark_ready(session_id)?))
            }
            CursorBridgeSessionControl::Forget | CursorBridgeSessionControl::Abandon => {
                require_confirm(confirm)?;
                self.remove_session(session_id)
            }
        }
    }

    fn plan_create(&self, spec: CursorBridgeCreateSpec) -> AppResult<CursorBridgeTurnPlan> {
        let workspace = require_absolute_path(&spec.workspace)?;
        let task = require_non_empty(&spec.task, error_codes::CURSOR_BRIDGE_TASK_REQUIRED)?;
        require_persistent_scope(spec.read_only, &spec.allowed_paths)?;
        let mut registry = self.load_registry()?;
        let session_id = new_id(CURSOR_BRIDGE_SESSION_PREFIX);
        let task_id = new_id(CURSOR_BRIDGE_TASK_PREFIX);
        let session = CursorBridgeSession {
            session_id: session_id.clone(),
            resume_chat_id: None,
            pty_session_id: None,
            launch_id: None,
            workspace: workspace.clone(),
            runtime_kind: spec.runtime_kind.clone(),
            scope: CursorBridgeScope {
                read_only: spec.read_only,
                allowed_paths: normalize_paths(&spec.allowed_paths),
            },
            model_id: spec.model_id.clone(),
            effort: spec.effort.clone(),
            epoch: 1,
            turn_index: 1,
            last_task_id: Some(task_id.clone()),
            last_request_id: nonempty_opt(spec.request_id.as_deref()),
            status: CursorBridgeSessionStatus::Creating,
        };
        registry.sessions.push(session);
        self.write_json(&self.sessions_path(), &registry)?;
        Ok(CursorBridgeTurnPlan {
            session_id: Some(session_id),
            task_id,
            prompt: build_do_prompt(task, spec.read_only, &spec.allowed_paths),
            print: spec.print,
            read_only: spec.read_only,
            resume_chat_id: None,
            model_id: spec.model_id,
            effort: spec.effort,
            replay: false,
            workspace,
            runtime_kind: spec.runtime_kind,
        })
    }

    fn plan_continue(
        &self,
        session_id: &str,
        spec: CursorBridgeCreateSpec,
    ) -> AppResult<CursorBridgeTurnPlan> {
        let task = require_non_empty(&spec.task, error_codes::CURSOR_BRIDGE_TASK_REQUIRED)?;
        let mut registry = self.load_registry()?;
        let session = find_session_mut(&mut registry, session_id)?;
        if session.status == CursorBridgeSessionStatus::Closed {
            return Err(AppError::coded(
                error_codes::CURSOR_BRIDGE_SESSION_CLOSED,
                "closed sessions cannot continue",
            ));
        }
        let workspace = require_absolute_path(&spec.workspace)?;
        assert_same_workspace(&session.workspace, &workspace)?;
        assert_continue_scope(&session.scope, spec.read_only, &spec.allowed_paths)?;
        if let Some(request_id) = nonempty_opt(spec.request_id.as_deref()) {
            if session.last_request_id.as_deref() == Some(request_id.as_str())
                && session.last_task_id.is_some()
            {
                return Ok(replay_plan(session, spec.print));
            }
        }
        let task_id = new_id(CURSOR_BRIDGE_TASK_PREFIX);
        session.epoch += 1;
        session.turn_index += 1;
        session.last_task_id = Some(task_id.clone());
        session.last_request_id = nonempty_opt(spec.request_id.as_deref());
        session.status = CursorBridgeSessionStatus::Busy;
        session.scope.allowed_paths = normalize_paths(&spec.allowed_paths);
        let plan = CursorBridgeTurnPlan {
            session_id: Some(session.session_id.clone()),
            task_id,
            prompt: build_do_prompt(task, spec.read_only, &spec.allowed_paths),
            print: spec.print,
            read_only: spec.read_only,
            resume_chat_id: session.resume_chat_id.clone(),
            model_id: session.model_id.clone(),
            effort: session.effort.clone(),
            replay: false,
            workspace,
            runtime_kind: session.runtime_kind.clone(),
        };
        self.write_json(&self.sessions_path(), &registry)?;
        Ok(plan)
    }

    fn mutate_session(
        &self,
        session_id: &str,
        mutate: impl FnOnce(&mut CursorBridgeSession),
    ) -> AppResult<CursorBridgeSession> {
        let _guard = self.lock.lock();
        let mut registry = self.load_registry()?;
        {
            let session = find_session_mut(&mut registry, session_id)?;
            mutate(session);
        }
        let snapshot = find_session(&registry, session_id)?.clone();
        self.write_json(&self.sessions_path(), &registry)?;
        Ok(snapshot)
    }

    fn remove_session(&self, session_id: &str) -> AppResult<Option<CursorBridgeSession>> {
        let _guard = self.lock.lock();
        let mut registry = self.load_registry()?;
        let index = registry
            .sessions
            .iter()
            .position(|session| session.session_id == session_id)
            .ok_or_else(|| session_not_found(session_id))?;
        let removed = registry.sessions.remove(index);
        self.write_json(&self.sessions_path(), &registry)?;
        Ok(Some(removed))
    }

    fn load_registry(&self) -> AppResult<CursorBridgeRegistry> {
        Ok(load_optional_json(&self.sessions_path())?.unwrap_or_default())
    }

    fn write_json<T: serde::Serialize>(&self, path: &Path, value: &T) -> AppResult<()> {
        let pretty = serde_json::to_string_pretty(value).map_err(|error| {
            AppError::coded(
                error_codes::CURSOR_BRIDGE_IO,
                format!("serialize failed: {error}"),
            )
        })?;
        write_atomic(path, pretty).map_err(|error| {
            AppError::coded(
                error_codes::CURSOR_BRIDGE_IO,
                format!("write failed: {error}"),
            )
        })?;
        Ok(())
    }

    fn sessions_path(&self) -> PathBuf {
        self.dir.join(SESSIONS_FILE)
    }
}

fn plan_isolated(spec: CursorBridgeCreateSpec) -> AppResult<CursorBridgeTurnPlan> {
    let workspace = require_absolute_path(&spec.workspace)?;
    let task = require_non_empty(&spec.task, error_codes::CURSOR_BRIDGE_TASK_REQUIRED)?;
    Ok(CursorBridgeTurnPlan {
        session_id: None,
        task_id: new_id(CURSOR_BRIDGE_TASK_PREFIX),
        prompt: build_do_prompt(task, spec.read_only, &spec.allowed_paths),
        print: spec.print,
        read_only: spec.read_only,
        resume_chat_id: None,
        model_id: spec.model_id,
        effort: spec.effort,
        replay: false,
        workspace,
        runtime_kind: spec.runtime_kind,
    })
}

fn replay_plan(session: &CursorBridgeSession, print: bool) -> CursorBridgeTurnPlan {
    CursorBridgeTurnPlan {
        session_id: Some(session.session_id.clone()),
        task_id: session
            .last_task_id
            .clone()
            .unwrap_or_else(|| new_id(CURSOR_BRIDGE_TASK_PREFIX)),
        prompt: String::new(),
        print,
        read_only: session.scope.read_only,
        resume_chat_id: session.resume_chat_id.clone(),
        model_id: session.model_id.clone(),
        effort: session.effort.clone(),
        replay: true,
        workspace: session.workspace.clone(),
        runtime_kind: session.runtime_kind.clone(),
    }
}

fn load_optional_json<T>(path: &Path) -> AppResult<Option<T>>
where
    T: serde::de::DeserializeOwned + SchemaVersioned,
{
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| {
        AppError::coded(
            error_codes::CURSOR_BRIDGE_IO,
            format!("read failed: {error}"),
        )
    })?;
    reject_unknown_schema(&raw, path)?;
    let value = serde_json::from_str(&raw).map_err(|error| {
        AppError::coded(
            error_codes::CURSOR_BRIDGE_IO,
            format!("parse failed: {error}"),
        )
    })?;
    Ok(Some(value))
}

fn reject_unknown_schema(raw: &str, path: &Path) -> AppResult<()> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| {
        AppError::coded(
            error_codes::CURSOR_BRIDGE_IO,
            format!("parse failed: {error}"),
        )
    })?;
    let version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version == 0 || version == u64::from(CURSOR_BRIDGE_SCHEMA_VERSION) {
        return Ok(());
    }
    Err(AppError::coded_with_params(
        error_codes::CURSOR_BRIDGE_UNKNOWN_SCHEMA,
        format!(
            "refusing to load unknown cursor-bridge schema {} from {}",
            version,
            path.display()
        ),
        [
            ("version".to_string(), version.to_string()),
            ("path".to_string(), path.display().to_string()),
        ]
        .into_iter()
        .collect(),
    ))
}

trait SchemaVersioned {}
impl SchemaVersioned for CursorBridgeRegistry {}
impl SchemaVersioned for CursorBridgeWorkspaceBinding {}
impl SchemaVersioned for CursorBridgeModelPreferences {}

fn find_session<'a>(
    registry: &'a CursorBridgeRegistry,
    session_id: &str,
) -> AppResult<&'a CursorBridgeSession> {
    registry
        .sessions
        .iter()
        .find(|session| session.session_id == session_id)
        .ok_or_else(|| session_not_found(session_id))
}

fn find_session_mut<'a>(
    registry: &'a mut CursorBridgeRegistry,
    session_id: &str,
) -> AppResult<&'a mut CursorBridgeSession> {
    registry
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
        .ok_or_else(|| session_not_found(session_id))
}

fn session_not_found(session_id: &str) -> AppError {
    AppError::coded(
        error_codes::CURSOR_BRIDGE_SESSION_NOT_FOUND,
        format!("cursor-bridge session not found: {session_id}"),
    )
}

fn require_confirm(confirm: bool) -> AppResult<()> {
    if confirm {
        return Ok(());
    }
    Err(AppError::coded(
        error_codes::CURSOR_BRIDGE_CONFIRM_REQUIRED,
        "forget/abandon require confirm=true",
    ))
}

fn require_persistent_scope(read_only: bool, allowed_paths: &[String]) -> AppResult<()> {
    if read_only || !allowed_paths.is_empty() {
        return Ok(());
    }
    Err(AppError::coded(
        error_codes::CURSOR_BRIDGE_SCOPE_REQUIRED,
        "persistent sessions require readOnly=true or allowedPaths",
    ))
}

fn assert_same_workspace(frozen: &str, requested: &str) -> AppResult<()> {
    if canonical_project_path(frozen) == canonical_project_path(requested) {
        return Ok(());
    }
    Err(AppError::coded(
        error_codes::CURSOR_BRIDGE_WORKSPACE_MISMATCH,
        "continue cannot switch workspace",
    ))
}

fn assert_continue_scope(
    frozen: &CursorBridgeScope,
    read_only: bool,
    allowed_paths: &[String],
) -> AppResult<()> {
    if frozen.read_only && !read_only {
        return Err(scope_expand("continue cannot drop readOnly"));
    }
    if frozen.read_only {
        return Ok(());
    }
    if allowed_paths.is_empty() {
        return Err(scope_expand(
            "continue must restate allowedPaths or readOnly=true",
        ));
    }
    let frozen_paths = normalize_paths(&frozen.allowed_paths);
    let next_paths = normalize_paths(allowed_paths);
    let ok = next_paths.iter().all(|path| {
        frozen_paths
            .iter()
            .any(|parent| is_path_within(parent, path))
    });
    if ok {
        return Ok(());
    }
    Err(scope_expand("continue cannot expand allowedPaths"))
}

fn scope_expand(message: &str) -> AppError {
    AppError::coded(error_codes::CURSOR_BRIDGE_SCOPE_EXPAND, message)
}

fn is_path_within(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn normalize_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| normalize_allowed_path(path))
        .filter(|path| !path.is_empty())
        .collect()
}

fn normalize_allowed_path(path: &str) -> String {
    canonical_project_path(path).replace('\\', "/")
}

fn require_absolute_path(path: &str) -> AppResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::coded(
            error_codes::PATH_EMPTY,
            "project path cannot be empty",
        ));
    }
    let normalized = canonical_project_path(trimmed);
    let looks_absolute = Path::new(&normalized).is_absolute()
        || normalized.starts_with('/')
        || normalized.chars().nth(1) == Some(':');
    if !looks_absolute {
        return Err(AppError::coded(
            error_codes::PATH_NOT_ABSOLUTE,
            format!("path must be absolute: {trimmed}"),
        ));
    }
    Ok(normalized)
}

fn require_non_empty<'a>(value: &'a str, code: &str) -> AppResult<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::coded(code, "required field is empty"));
    }
    Ok(trimmed)
}

fn nonempty_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn spec(workspace: &str, task: &str) -> CursorBridgeCreateSpec {
        CursorBridgeCreateSpec {
            workspace: workspace.to_string(),
            runtime_kind: Some("local".into()),
            read_only: false,
            allowed_paths: vec![format!("{workspace}/web")],
            request_id: None,
            model_id: Some("grok".into()),
            effort: None,
            task: task.to_string(),
            print: false,
        }
    }

    #[test]
    fn isolated_does_not_write_sessions_file() {
        let dir = tempdir().unwrap();
        let service = CursorBridgeService::open(dir.path());
        let plan = service
            .plan_do(
                CursorBridgeSessionMode::Isolated,
                spec("D:/repo", "do it"),
                None,
            )
            .unwrap();
        assert!(plan.session_id.is_none());
        assert!(!dir.path().join(SESSIONS_FILE).exists());
    }

    #[test]
    fn create_ready_continue_bumps_epoch_and_task() {
        let dir = tempdir().unwrap();
        let service = CursorBridgeService::open(dir.path());
        let created = service
            .plan_do(
                CursorBridgeSessionMode::Create,
                spec("D:/repo", "first"),
                None,
            )
            .unwrap();
        let session_id = created.session_id.clone().unwrap();
        service
            .attach_launch(&session_id, "launch-1", "pty-1")
            .unwrap();
        service.bind_resume_chat_id("launch-1", "chat-abc").unwrap();
        let continued = service
            .plan_do(
                CursorBridgeSessionMode::Continue,
                spec("D:/repo", "second"),
                Some(&session_id),
            )
            .unwrap();
        assert_ne!(continued.task_id, created.task_id);
        assert_eq!(continued.resume_chat_id.as_deref(), Some("chat-abc"));
        let stored = service.get_session(&session_id).unwrap();
        assert_eq!(stored.epoch, 2);
        assert_eq!(stored.turn_index, 2);
        assert_eq!(stored.status, CursorBridgeSessionStatus::Busy);
    }

    #[test]
    fn request_id_replay_does_not_create_second_task() {
        let dir = tempdir().unwrap();
        let service = CursorBridgeService::open(dir.path());
        let mut first = spec("D:/repo", "first");
        first.request_id = Some("req-1".into());
        let created = service
            .plan_do(CursorBridgeSessionMode::Create, first.clone(), None)
            .unwrap();
        let session_id = created.session_id.clone().unwrap();
        service
            .bind_resume_chat_id(
                service
                    .attach_launch(&session_id, "launch-1", "pty-1")
                    .unwrap()
                    .launch_id
                    .as_deref()
                    .unwrap(),
                "chat-abc",
            )
            .unwrap();
        let mut again = spec("D:/repo", "ignored");
        again.request_id = Some("req-1".into());
        let replay = service
            .plan_do(CursorBridgeSessionMode::Continue, again, Some(&session_id))
            .unwrap();
        assert!(replay.replay);
        assert_eq!(replay.task_id, created.task_id);
        assert_eq!(service.get_session(&session_id).unwrap().epoch, 1);
    }

    #[test]
    fn continue_rejects_scope_and_workspace_expansion() {
        let dir = tempdir().unwrap();
        let service = CursorBridgeService::open(dir.path());
        let created = service
            .plan_do(
                CursorBridgeSessionMode::Create,
                spec("D:/repo", "first"),
                None,
            )
            .unwrap();
        let session_id = created.session_id.unwrap();
        let mut wider = spec("D:/repo", "second");
        wider.allowed_paths = vec!["D:/repo".into()];
        let err = service
            .plan_do(CursorBridgeSessionMode::Continue, wider, Some(&session_id))
            .unwrap_err();
        assert_eq!(err.code(), Some(error_codes::CURSOR_BRIDGE_SCOPE_EXPAND));

        let err = service
            .plan_do(
                CursorBridgeSessionMode::Continue,
                spec("D:/other", "second"),
                Some(&session_id),
            )
            .unwrap_err();
        assert_eq!(
            err.code(),
            Some(error_codes::CURSOR_BRIDGE_WORKSPACE_MISMATCH)
        );
    }

    #[test]
    fn unknown_schema_is_rejected_without_overwrite() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SESSIONS_FILE);
        let original = r#"{"schemaVersion":99,"sessions":[{"keep":true}]}"#;
        std::fs::write(&path, original).unwrap();
        let service = CursorBridgeService::open(dir.path());
        let err = service.list_sessions().unwrap_err();
        assert_eq!(err.code(), Some(error_codes::CURSOR_BRIDGE_UNKNOWN_SCHEMA));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn forget_requires_confirm() {
        let dir = tempdir().unwrap();
        let service = CursorBridgeService::open(dir.path());
        let created = service
            .plan_do(
                CursorBridgeSessionMode::Create,
                spec("D:/repo", "first"),
                None,
            )
            .unwrap();
        let session_id = created.session_id.unwrap();
        let err = service
            .control_session(&session_id, CursorBridgeSessionControl::Forget, false)
            .unwrap_err();
        assert_eq!(
            err.code(),
            Some(error_codes::CURSOR_BRIDGE_CONFIRM_REQUIRED)
        );
        service
            .control_session(&session_id, CursorBridgeSessionControl::Forget, true)
            .unwrap();
        assert!(service.get_session(&session_id).is_err());
    }
}
