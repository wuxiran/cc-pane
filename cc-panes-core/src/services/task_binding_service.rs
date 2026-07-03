use crate::events::EventEmitter;
use crate::models::task_binding::*;
use crate::repository::TaskBindingRepository;
use crate::utils::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, warn};

const TASK_BINDING_CHANGED_EVENT: &str = "task-binding-changed";
const TASK_BINDING_PATCH_MAX_BYTES: usize = 64 * 1024;
const TASK_BINDING_MERGE_PATCH_MAX_DEPTH: usize = 16;

/// TaskBinding 业务逻辑层
pub struct TaskBindingService {
    repo: Arc<TaskBindingRepository>,
    emitter: parking_lot::RwLock<Option<Arc<dyn EventEmitter>>>,
    /// 串行化 "读旧状态 + 更新" 这对操作（见 update_returning_previous_status）
    update_lock: std::sync::Mutex<()>,
}

impl TaskBindingService {
    pub fn new(repo: Arc<TaskBindingRepository>) -> Self {
        Self {
            repo,
            emitter: parking_lot::RwLock::new(None),
            update_lock: std::sync::Mutex::new(()),
        }
    }

    pub fn set_emitter(&self, emitter: Arc<dyn EventEmitter>) {
        *self.emitter.write() = Some(emitter);
    }

    /// 创建 TaskBinding
    pub fn create(&self, req: CreateTaskBindingRequest) -> AppResult<TaskBinding> {
        self.create_with_emit(req, true)
    }

    fn create_with_emit(
        &self,
        req: CreateTaskBindingRequest,
        emit: bool,
    ) -> AppResult<TaskBinding> {
        debug!("svc::create_task_binding");
        let title = req.title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::from("TaskBinding title cannot be empty"));
        }

        let plan_path = clean_optional(req.plan_path);
        let normalized_plan_path = clean_optional(req.normalized_plan_path)
            .or_else(|| plan_path.as_deref().map(normalize_plan_path));

        let now = chrono::Utc::now().to_rfc3339();
        let binding = TaskBinding {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            role: req.role.unwrap_or(TaskBindingRole::Task),
            parent_id: clean_optional(req.parent_id),
            plan_path,
            normalized_plan_path,
            prompt: req.prompt,
            session_id: clean_optional(req.session_id),
            resume_id: clean_optional(req.resume_id),
            pane_id: clean_optional(req.pane_id),
            tab_id: clean_optional(req.tab_id),
            todo_id: clean_optional(req.todo_id),
            project_path: req.project_path,
            workspace_name: clean_optional(req.workspace_name),
            cli_tool: clean_optional(req.cli_tool).unwrap_or_else(|| "claude".to_string()),
            status: TaskBindingStatus::Pending,
            progress: 0,
            completion_summary: None,
            exit_code: None,
            sort_order: 0,
            metadata: req.metadata,
            created_at: now.clone(),
            updated_at: now,
        };

        self.repo.insert(&binding)?;
        if emit {
            self.emit_changed(TaskBindingChangeOp::Create, &binding.id, Some(&binding));
        }
        Ok(binding)
    }

    /// 获取 TaskBinding
    pub fn get(&self, id: &str) -> AppResult<Option<TaskBinding>> {
        Ok(self.repo.get(id)?)
    }

    /// 根据 session_id 查找
    pub fn find_by_session_id(&self, session_id: &str) -> AppResult<Option<TaskBinding>> {
        Ok(self.repo.find_by_session_id(session_id)?)
    }

    /// 更新 TaskBinding
    pub fn update(&self, id: &str, req: UpdateTaskBindingRequest) -> AppResult<TaskBinding> {
        self.update_with_emit(id, req, true)
    }

    /// 原子更新并返回更新前的 status。
    ///
    /// 用于 leader 终态通知去重：调用方若"先 get 旧状态、再 update"，两个并发
    /// 更新会都读到同一个非终态旧值、都判定为"跃迁到终态"而重复通知 leader。
    /// 这里用 update_lock 串行化 read-old + update，保证第二个调用读到的旧状态
    /// 已是第一个写入的新值。
    pub fn update_returning_previous_status(
        &self,
        id: &str,
        req: UpdateTaskBindingRequest,
    ) -> AppResult<(Option<TaskBindingStatus>, TaskBinding)> {
        let _guard = self.update_lock.lock().unwrap_or_else(|e| e.into_inner());
        let old_status = self.repo.get(id)?.map(|binding| binding.status);
        let binding = self.update_with_emit(id, req, true)?;
        Ok((old_status, binding))
    }

    fn update_with_emit(
        &self,
        id: &str,
        mut req: UpdateTaskBindingRequest,
        emit: bool,
    ) -> AppResult<TaskBinding> {
        debug!("svc::update_task_binding");
        if let Some(ref title) = req.title {
            if title.trim().is_empty() {
                return Err(AppError::from("TaskBinding title cannot be empty"));
            }
        }

        // 验证 progress 范围
        if let Some(progress) = req.progress {
            if !(0..=100).contains(&progress) {
                return Err(AppError::from("Progress must be between 0 and 100"));
            }
        }

        if req.normalized_plan_path.is_none() {
            req.normalized_plan_path = req.plan_path.as_deref().map(normalize_plan_path);
        }

        self.repo.update(id, &req)?;
        let binding = self
            .get(id)?
            .ok_or_else(|| AppError::from(format!("TaskBinding '{}' not found", id)))?;
        if emit {
            self.emit_changed(TaskBindingChangeOp::Update, id, Some(&binding));
        }
        Ok(binding)
    }

    /// JSON merge-patch style update. Only `metadata` is deeply merged; other
    /// fields follow UpdateTaskBindingRequest's existing "present means update"
    /// semantics.
    pub fn update_patch(&self, id: &str, patch: serde_json::Value) -> AppResult<TaskBinding> {
        let existing = self
            .repo
            .get(id)?
            .ok_or_else(|| AppError::from(format!("TaskBinding '{}' not found", id)))?;
        let mut req = task_binding_patch_to_update_request(&existing, patch)?;
        if req.normalized_plan_path.is_none() {
            req.normalized_plan_path = req.plan_path.as_deref().map(normalize_plan_path);
        }
        self.update(id, req)
    }

    /// 删除 TaskBinding
    pub fn delete(&self, id: &str) -> AppResult<bool> {
        let deleted = self.repo.delete(id)?;
        if deleted {
            self.emit_changed(TaskBindingChangeOp::Delete, id, None);
        }
        Ok(deleted)
    }

    /// 原子级联删除 TaskBinding 及所有后代。
    pub fn delete_cascade(&self, id: &str) -> AppResult<bool> {
        // fix(H3) review: 级联删除在后端单事务内完成，避免前端多次删除的半失败状态。
        let deleted_ids = self.repo.delete_cascade(id)?;
        let deleted = !deleted_ids.is_empty();
        for deleted_id in deleted_ids {
            self.emit_changed(TaskBindingChangeOp::Delete, &deleted_id, None);
        }
        Ok(deleted)
    }

    /// 查询 TaskBindings
    pub fn query(&self, mut query: TaskBindingQuery) -> AppResult<TaskBindingQueryResult> {
        if query.normalized_plan_path.is_none() {
            query.normalized_plan_path = query.plan_path.as_deref().map(normalize_plan_path);
            if query.normalized_plan_path.is_some() {
                query.plan_path = None;
            }
        }
        Ok(self.repo.query(&query)?)
    }

    pub fn register_plan_leader(&self, req: RegisterPlanLeaderRequest) -> AppResult<TaskBinding> {
        let plan_path = req.plan_path.trim().to_string();
        if plan_path.is_empty() {
            return Err(AppError::from("planPath cannot be empty"));
        }
        let normalized_plan_path = normalize_plan_path(&plan_path);
        let project_path = req.project_path.trim().to_string();
        if project_path.is_empty() {
            return Err(AppError::from("projectPath cannot be empty"));
        }
        let session_id = clean_optional(req.session_id).ok_or_else(|| {
            AppError::from(
                "Plan leader requires sessionId; read CC_PANES_PTY_SESSION_ID from the current CC-Panes-launched session before calling register_plan_leader",
            )
        })?;

        if let Some(existing) = self
            .repo
            .find_leader_by_plan(&normalized_plan_path, Some(&project_path))?
        {
            let binding = self.update_with_emit(
                &existing.id,
                UpdateTaskBindingRequest {
                    title: req.title,
                    role: Some(TaskBindingRole::Leader),
                    plan_path: Some(plan_path),
                    normalized_plan_path: Some(normalized_plan_path),
                    prompt: req.prompt,
                    session_id: Some(session_id),
                    resume_id: req.resume_id,
                    pane_id: req.pane_id,
                    tab_id: req.tab_id,
                    metadata: req.metadata,
                    ..Default::default()
                },
                false,
            )?;
            // fix(M1) review: register 中间 update 静默，只发最终 Register 事件。
            self.emit_changed(TaskBindingChangeOp::Register, &binding.id, Some(&binding));
            return Ok(binding);
        }

        let title = req
            .title
            .unwrap_or_else(|| format!("Plan: {}", plan_file_name(&plan_path)));
        let created = self.create_with_emit(
            CreateTaskBindingRequest {
                title,
                role: Some(TaskBindingRole::Leader),
                parent_id: None,
                plan_path: Some(plan_path),
                normalized_plan_path: Some(normalized_plan_path),
                prompt: req.prompt,
                session_id: Some(session_id),
                resume_id: req.resume_id,
                pane_id: req.pane_id,
                tab_id: req.tab_id,
                todo_id: None,
                project_path,
                workspace_name: req.workspace_name,
                cli_tool: req.cli_tool.or_else(|| Some("claude".to_string())),
                metadata: req.metadata,
            },
            false,
        )?;
        let binding = self.update_with_emit(
            &created.id,
            UpdateTaskBindingRequest {
                status: Some(TaskBindingStatus::Running),
                ..Default::default()
            },
            false,
        )?;
        // fix(M1) review: register create/update 静默，只发最终 Register 事件。
        self.emit_changed(TaskBindingChangeOp::Register, &binding.id, Some(&binding));
        Ok(binding)
    }

    pub fn register_plan_worker(&self, req: RegisterPlanWorkerRequest) -> AppResult<TaskBinding> {
        let leader = self.resolve_leader(&PlanCollaborationKey {
            leader_id: req.leader_id.clone(),
            plan_path: req.plan_path.clone(),
            normalized_plan_path: req.plan_path.as_deref().map(normalize_plan_path),
        })?;

        let plan_path = req
            .plan_path
            .or_else(|| leader.plan_path.clone())
            .ok_or_else(|| {
                AppError::from("Plan worker requires planPath or a leader with planPath")
            })?;
        let normalized_plan_path = normalize_plan_path(&plan_path);
        let cli_tool = clean_optional(req.cli_tool).unwrap_or_else(|| "codex".to_string());
        let title = req.title.unwrap_or_else(|| format!("Worker: {}", cli_tool));

        if let Some(existing) = self.repo.find_worker_for_registration(
            &leader.id,
            &req.session_id,
            req.resume_id.as_deref(),
        )? {
            let binding = self.update_with_emit(
                &existing.id,
                UpdateTaskBindingRequest {
                    title: Some(title),
                    role: Some(TaskBindingRole::Worker),
                    parent_id: Some(leader.id),
                    plan_path: Some(plan_path),
                    normalized_plan_path: Some(normalized_plan_path),
                    prompt: req.prompt,
                    session_id: Some(req.session_id),
                    resume_id: req.resume_id,
                    pane_id: req.pane_id,
                    tab_id: req.tab_id,
                    status: Some(TaskBindingStatus::Running),
                    metadata: req.metadata,
                    ..Default::default()
                },
                false,
            )?;
            // fix(M1) review: worker register 中间 update 静默，只发最终 Register 事件。
            self.emit_changed(TaskBindingChangeOp::Register, &binding.id, Some(&binding));
            return Ok(binding);
        }

        let created = self.create_with_emit(
            CreateTaskBindingRequest {
                title,
                role: Some(TaskBindingRole::Worker),
                parent_id: Some(leader.id),
                plan_path: Some(plan_path),
                normalized_plan_path: Some(normalized_plan_path),
                prompt: req.prompt,
                session_id: Some(req.session_id),
                resume_id: req.resume_id,
                pane_id: req.pane_id,
                tab_id: req.tab_id,
                todo_id: None,
                project_path: req.project_path,
                workspace_name: req.workspace_name,
                cli_tool: Some(cli_tool),
                metadata: req.metadata,
            },
            false,
        )?;
        let binding = self.update_with_emit(
            &created.id,
            UpdateTaskBindingRequest {
                status: Some(TaskBindingStatus::Running),
                ..Default::default()
            },
            false,
        )?;
        // fix(M1) review: worker register create/update 静默，只发最终 Register 事件。
        self.emit_changed(TaskBindingChangeOp::Register, &binding.id, Some(&binding));
        Ok(binding)
    }

    /// Backward-compatible wrapper for callers still using the old child name.
    pub fn register_plan_child(&self, req: RegisterPlanChildRequest) -> AppResult<TaskBinding> {
        self.register_plan_worker(req)
    }

    pub fn get_plan_collaboration(
        &self,
        key: PlanCollaborationKey,
        verbose: bool,
    ) -> AppResult<PlanCollaboration> {
        let leader = self.resolve_leader(&key)?;
        let workers = self.repo.find_workers_of(&leader.id)?;
        Ok(collaboration_from_bindings(
            leader,
            workers,
            &HashMap::new(),
            verbose,
        ))
    }

    pub fn reconcile_plan_collaboration(
        &self,
        key: PlanCollaborationKey,
        live_sessions: Vec<PlanLiveSession>,
        verbose: bool,
    ) -> AppResult<PlanCollaboration> {
        let live_map = live_sessions
            .into_iter()
            .map(|session| (session.session_id.clone(), session))
            .collect::<HashMap<_, _>>();

        let leader = self.resolve_leader(&key)?;
        let workers = self.repo.find_workers_of(&leader.id)?;

        let mut reconciled_ids = Vec::new();
        for binding in std::iter::once(&leader).chain(workers.iter()) {
            let Some(session_id) = binding.session_id.as_deref() else {
                continue;
            };
            let live = live_map.get(session_id);
            if let Some(live) = live {
                if (live.pane_id != binding.pane_id || live.tab_id != binding.tab_id)
                    && self.repo.update(
                        &binding.id,
                        &UpdateTaskBindingRequest {
                            pane_id: live.pane_id.clone(),
                            tab_id: live.tab_id.clone(),
                            ..Default::default()
                        },
                    )?
                {
                    reconciled_ids.push(binding.id.clone());
                }
                continue;
            }

            if binding.role == TaskBindingRole::Worker
                && binding.status == TaskBindingStatus::Running
                && self.repo.update(
                    &binding.id,
                    &UpdateTaskBindingRequest {
                        status: Some(TaskBindingStatus::Waiting),
                        ..Default::default()
                    },
                )?
            {
                reconciled_ids.push(binding.id.clone());
            }
        }

        let refreshed_leader = self
            .repo
            .get(&leader.id)?
            .ok_or_else(|| AppError::from("Plan leader disappeared during reconcile"))?;
        let refreshed_workers = self.repo.find_workers_of(&refreshed_leader.id)?;
        if !reconciled_ids.is_empty() {
            // fix(M1) review: reconcile 批量更新后只发一次 Reconcile 事件，避免事件风暴。
            self.emit_changed(
                TaskBindingChangeOp::Reconcile,
                &refreshed_leader.id,
                Some(&refreshed_leader),
            );
        }
        Ok(collaboration_from_bindings(
            refreshed_leader,
            refreshed_workers,
            &live_map,
            verbose,
        ))
    }

    fn resolve_leader(&self, key: &PlanCollaborationKey) -> AppResult<TaskBinding> {
        if let Some(leader_id) = key.leader_id.as_deref().filter(|id| !id.trim().is_empty()) {
            let binding = self
                .repo
                .get(leader_id)?
                .ok_or_else(|| AppError::from(format!("Plan leader '{}' not found", leader_id)))?;
            if binding.role != TaskBindingRole::Leader {
                return Err(AppError::from(format!(
                    "TaskBinding '{}' is not a plan leader",
                    leader_id
                )));
            }
            return Ok(binding);
        }

        let normalized_plan_path = key
            .normalized_plan_path
            .clone()
            .or_else(|| key.plan_path.as_deref().map(normalize_plan_path))
            .ok_or_else(|| AppError::from("leaderId or planPath is required"))?;

        self.repo
            .find_leader_by_plan(&normalized_plan_path, None)?
            .ok_or_else(|| {
                AppError::from(format!(
                    "Plan leader for '{}' not found",
                    key.plan_path.as_deref().unwrap_or(&normalized_plan_path)
                ))
            })
    }

    fn emit_changed(&self, op: TaskBindingChangeOp, id: &str, binding: Option<&TaskBinding>) {
        let Some(emitter) = self.emitter.read().as_ref().cloned() else {
            return;
        };
        let mut payload = serde_json::json!({
            "op": op.as_str(),
            "id": id,
        });
        if let Some(binding) = binding {
            payload["binding"] = serde_json::to_value(binding).unwrap_or(serde_json::Value::Null);
        }
        let _ = emitter.emit(TASK_BINDING_CHANGED_EVENT, payload);
    }
}

#[derive(Debug, Clone, Copy)]
enum TaskBindingChangeOp {
    Create,
    Update,
    Delete,
    Register,
    Reconcile,
}

impl TaskBindingChangeOp {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Register => "register",
            Self::Reconcile => "reconcile",
        }
    }
}

fn collaboration_from_bindings(
    leader: TaskBinding,
    workers: Vec<TaskBinding>,
    live_map: &HashMap<String, PlanLiveSession>,
    verbose: bool,
) -> PlanCollaboration {
    let leader = entry_from_binding(leader, live_map, verbose);
    let workers = workers
        .into_iter()
        .map(|binding| entry_from_binding(binding, live_map, verbose))
        .collect::<Vec<_>>();
    PlanCollaboration {
        total: workers.len() as u32,
        leader,
        workers,
    }
}

fn entry_from_binding(
    binding: TaskBinding,
    live_map: &HashMap<String, PlanLiveSession>,
    verbose: bool,
) -> PlanCollaborationEntry {
    let live = binding
        .session_id
        .as_deref()
        .and_then(|session_id| live_map.get(session_id));
    let is_live = live.is_some();
    let can_relaunch =
        binding.resume_id.is_some() || binding.plan_path.is_some() || binding.prompt.is_some();
    PlanCollaborationEntry {
        id: binding.id,
        title: binding.title,
        role: binding.role,
        parent_id: binding.parent_id,
        plan_path: binding.plan_path,
        normalized_plan_path: binding.normalized_plan_path,
        project_path: binding.project_path,
        workspace_name: binding.workspace_name,
        cli_tool: binding.cli_tool,
        status: binding.status,
        progress: binding.progress,
        session_id: binding.session_id,
        resume_id: binding.resume_id,
        pane_id: binding.pane_id,
        tab_id: binding.tab_id,
        is_live,
        can_relaunch,
        live_pane_id: live.and_then(|session| session.pane_id.clone()),
        live_tab_id: live.and_then(|session| session.tab_id.clone()),
        prompt: verbose.then_some(binding.prompt).flatten(),
        completion_summary: verbose.then_some(binding.completion_summary).flatten(),
        metadata: verbose.then_some(binding.metadata).flatten(),
        created_at: binding.created_at,
        updated_at: binding.updated_at,
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn task_binding_patch_to_update_request(
    existing: &TaskBinding,
    patch: serde_json::Value,
) -> AppResult<UpdateTaskBindingRequest> {
    let patch_len = serde_json::to_vec(&patch)
        .map_err(|error| AppError::from(format!("Invalid TaskBinding patch: {}", error)))?
        .len();
    if patch_len > TASK_BINDING_PATCH_MAX_BYTES {
        return Err(AppError::from(format!(
            "TaskBinding patch must be <= {} bytes",
            TASK_BINDING_PATCH_MAX_BYTES
        )));
    }

    let patch_object = patch
        .as_object()
        .ok_or_else(|| AppError::from("TaskBinding patch must be a JSON object"))?;

    let mut request_object = serde_json::Map::new();
    // fix(C1) review: patch 字段白名单，只允许 UI 安全字段，关键绑定字段静默丢弃并记录 warn。
    for (key, value) in patch_object {
        match key.as_str() {
            "title" | "status" | "progress" | "completionSummary" | "exitCode" | "sortOrder"
            | "metadata" | "prompt" => {
                request_object.insert(key.clone(), value.clone());
            }
            "role" | "parentId" | "planPath" | "normalizedPlanPath" | "resumeId" | "sessionId"
            | "paneId" | "tabId" => {
                warn!(field = %key, "Dropping protected TaskBinding patch field");
            }
            _ => {
                warn!(field = %key, "Dropping unsupported TaskBinding patch field");
            }
        }
    }
    let metadata_patch = request_object.remove("metadata");
    let mut request: UpdateTaskBindingRequest =
        serde_json::from_value(serde_json::Value::Object(request_object))
            .map_err(|error| AppError::from(format!("Invalid TaskBinding patch: {}", error)))?;

    if let Some(metadata_patch) = metadata_patch {
        let mut metadata = existing
            .metadata
            .clone()
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        // fix(H1) review: merge-patch 递归深度限制，防止极深 JSON 占用栈/CPU。
        apply_json_merge_patch(&mut metadata, metadata_patch, 0)?;
        request.metadata = Some(metadata);
    }

    Ok(request)
}

fn apply_json_merge_patch(
    target: &mut serde_json::Value,
    patch: serde_json::Value,
    depth: usize,
) -> AppResult<()> {
    if depth > TASK_BINDING_MERGE_PATCH_MAX_DEPTH {
        return Err(AppError::from(format!(
            "TaskBinding metadata patch depth must be <= {}",
            TASK_BINDING_MERGE_PATCH_MAX_DEPTH
        )));
    }

    match patch {
        serde_json::Value::Object(patch_object) => {
            if !target.is_object() {
                *target = serde_json::Value::Object(serde_json::Map::new());
            }
            let Some(target_object) = target.as_object_mut() else {
                return Ok(());
            };
            for (key, value) in patch_object {
                if value.is_null() {
                    target_object.remove(&key);
                } else {
                    apply_json_merge_patch(
                        target_object.entry(key).or_insert(serde_json::Value::Null),
                        value,
                        depth + 1,
                    )?;
                }
            }
        }
        other => {
            *target = other;
        }
    }
    Ok(())
}

pub fn normalize_plan_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized = normalized.trim_end_matches('/').to_string();

    let lower = normalized.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("/mnt/") {
        let mut parts = rest.splitn(2, '/');
        if let (Some(drive), Some(path_rest)) = (parts.next(), parts.next()) {
            if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
                return format!("{}:/{}", drive, path_rest);
            }
        }
    }

    if let Some(mnt_index) = lower.find("/mnt/") {
        let rest = &lower[mnt_index + "/mnt/".len()..];
        let mut parts = rest.splitn(2, '/');
        if let (Some(drive), Some(path_rest)) = (parts.next(), parts.next()) {
            if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
                return format!("{}:/{}", drive, path_rest);
            }
        }
    }

    if lower.len() >= 3 && lower.as_bytes()[1] == b':' && lower.as_bytes()[2] == b'/' {
        lower
    } else {
        normalized
    }
}

fn plan_file_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("plan.md")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{Database, TaskBindingRepository};

    fn service() -> TaskBindingService {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        TaskBindingService::new(Arc::new(TaskBindingRepository::new(db)))
    }

    #[test]
    fn test_normalize_plan_path_unifies_windows_and_wsl_drive_paths() {
        assert_eq!(
            normalize_plan_path(r"D:\repo\.claude\plans\Plan.md"),
            "d:/repo/.claude/plans/plan.md"
        );
        assert_eq!(
            normalize_plan_path("/mnt/d/repo/.claude/plans/Plan.md"),
            "d:/repo/.claude/plans/plan.md"
        );
        assert_eq!(
            normalize_plan_path(r"\\wsl.localhost\Ubuntu\mnt\d\repo\.claude\plans\Plan.md"),
            "d:/repo/.claude/plans/plan.md"
        );
    }

    #[test]
    fn test_register_leader_is_idempotent_by_plan_and_project() {
        let service = service();
        let first = service
            .register_plan_leader(RegisterPlanLeaderRequest {
                plan_path: r"D:\repo\.claude\plans\plan.md".into(),
                project_path: "D:/repo".into(),
                title: Some("First".into()),
                prompt: None,
                session_id: Some("pty-1".into()),
                resume_id: None,
                pane_id: None,
                tab_id: None,
                workspace_name: None,
                cli_tool: None,
                metadata: None,
            })
            .expect("register first");
        let second = service
            .register_plan_leader(RegisterPlanLeaderRequest {
                plan_path: "/mnt/d/repo/.claude/plans/plan.md".into(),
                project_path: "D:/repo".into(),
                title: Some("Second".into()),
                prompt: None,
                session_id: Some("pty-2".into()),
                resume_id: Some("resume-2".into()),
                pane_id: None,
                tab_id: None,
                workspace_name: None,
                cli_tool: None,
                metadata: None,
            })
            .expect("register second");

        assert_eq!(first.id, second.id);
        assert_eq!(second.title, "Second");
        assert_eq!(second.session_id.as_deref(), Some("pty-2"));
        assert_eq!(second.resume_id.as_deref(), Some("resume-2"));
    }

    #[test]
    fn test_register_leader_requires_session_id() {
        let service = service();
        let error = service
            .register_plan_leader(RegisterPlanLeaderRequest {
                plan_path: r"D:\repo\.claude\plans\plan.md".into(),
                project_path: "D:/repo".into(),
                title: Some("Leader".into()),
                prompt: None,
                session_id: Some("   ".into()),
                resume_id: None,
                pane_id: None,
                tab_id: None,
                workspace_name: None,
                cli_tool: None,
                metadata: None,
            })
            .expect_err("leader registration without sessionId should fail");

        assert!(error.to_string().contains("requires sessionId"));
    }

    #[test]
    fn test_register_worker_requires_existing_leader() {
        let service = service();
        let result = service.register_plan_worker(RegisterPlanWorkerRequest {
            leader_id: Some("missing".into()),
            plan_path: None,
            session_id: "pty-worker".into(),
            project_path: "D:/repo".into(),
            title: None,
            prompt: None,
            resume_id: None,
            pane_id: None,
            tab_id: None,
            workspace_name: None,
            cli_tool: None,
            metadata: None,
        });

        assert!(result.is_err());
    }

    #[test]
    fn update_patch_deep_merges_metadata_without_dropping_siblings() {
        let service = service();
        let binding = service
            .create(CreateTaskBindingRequest {
                title: "Worker".into(),
                role: Some(TaskBindingRole::Worker),
                parent_id: None,
                plan_path: None,
                normalized_plan_path: None,
                prompt: None,
                session_id: None,
                resume_id: None,
                pane_id: None,
                tab_id: None,
                todo_id: None,
                project_path: "D:/repo".into(),
                workspace_name: None,
                cli_tool: Some("codex".into()),
                metadata: Some(serde_json::json!({
                    "monitorMode": "worker_report",
                    "ui": {
                        "muted": false,
                        "retryOf": "old"
                    }
                })),
            })
            .expect("create");

        let updated = service
            .update_patch(
                &binding.id,
                serde_json::json!({
                    "metadata": {
                        "ui": {
                            "muted": true,
                            "retryOf": null
                        }
                    }
                }),
            )
            .expect("patch");

        let metadata = updated.metadata.expect("metadata");
        assert_eq!(metadata["monitorMode"], "worker_report");
        assert_eq!(metadata["ui"]["muted"], true);
        assert!(metadata["ui"].get("retryOf").is_none());
    }

    #[test]
    fn update_patch_ignores_protected_binding_fields() {
        let service = service();
        let binding = service
            .create(CreateTaskBindingRequest {
                title: "Worker".into(),
                role: Some(TaskBindingRole::Worker),
                parent_id: Some("leader-1".into()),
                plan_path: Some("D:/repo/.claude/plans/plan.md".into()),
                normalized_plan_path: Some("d:/repo/.claude/plans/plan.md".into()),
                prompt: Some("old prompt".into()),
                session_id: Some("pty-old".into()),
                resume_id: Some("resume-old".into()),
                pane_id: Some("pane-old".into()),
                tab_id: Some("tab-old".into()),
                todo_id: None,
                project_path: "D:/repo".into(),
                workspace_name: None,
                cli_tool: Some("codex".into()),
                metadata: Some(serde_json::json!({ "ui": { "muted": false } })),
            })
            .expect("create");

        let updated = service
            .update_patch(
                &binding.id,
                serde_json::json!({
                    "title": "Allowed title",
                    "prompt": "allowed prompt",
                    "status": "running",
                    "progress": 42,
                    "role": "leader",
                    "parentId": "leader-2",
                    "planPath": "D:/other/plan.md",
                    "normalizedPlanPath": "d:/other/plan.md",
                    "resumeId": "resume-new",
                    "sessionId": "pty-new",
                    "paneId": "pane-new",
                    "tabId": "tab-new",
                    "metadata": { "ui": { "muted": true } }
                }),
            )
            .expect("patch");

        // fix(C1) review: 允许字段生效，role/parent/session/pane/tab/plan 等关键字段被忽略。
        assert_eq!(updated.title, "Allowed title");
        assert_eq!(updated.prompt.as_deref(), Some("allowed prompt"));
        assert_eq!(updated.status, TaskBindingStatus::Running);
        assert_eq!(updated.progress, 42);
        assert_eq!(updated.role, TaskBindingRole::Worker);
        assert_eq!(updated.parent_id.as_deref(), Some("leader-1"));
        assert_eq!(
            updated.plan_path.as_deref(),
            Some("D:/repo/.claude/plans/plan.md")
        );
        assert_eq!(
            updated.normalized_plan_path.as_deref(),
            Some("d:/repo/.claude/plans/plan.md")
        );
        assert_eq!(updated.session_id.as_deref(), Some("pty-old"));
        assert_eq!(updated.resume_id.as_deref(), Some("resume-old"));
        assert_eq!(updated.pane_id.as_deref(), Some("pane-old"));
        assert_eq!(updated.tab_id.as_deref(), Some("tab-old"));
        assert_eq!(updated.metadata.unwrap()["ui"]["muted"], true);
    }

    #[test]
    fn test_reconcile_marks_dead_running_worker_waiting_without_clearing_pane() {
        let service = service();
        let leader = service
            .register_plan_leader(RegisterPlanLeaderRequest {
                plan_path: "D:/repo/.claude/plans/plan.md".into(),
                project_path: "D:/repo".into(),
                title: None,
                prompt: None,
                session_id: Some("pty-leader".into()),
                resume_id: None,
                pane_id: Some("pane-leader".into()),
                tab_id: None,
                workspace_name: None,
                cli_tool: None,
                metadata: None,
            })
            .expect("leader");
        let worker = service
            .register_plan_worker(RegisterPlanWorkerRequest {
                leader_id: Some(leader.id.clone()),
                plan_path: None,
                session_id: "pty-worker".into(),
                project_path: "D:/repo".into(),
                title: None,
                prompt: None,
                resume_id: None,
                pane_id: Some("pane-worker".into()),
                tab_id: Some("tab-worker".into()),
                workspace_name: None,
                cli_tool: None,
                metadata: None,
            })
            .expect("worker");

        let result = service
            .reconcile_plan_collaboration(
                PlanCollaborationKey {
                    leader_id: Some(leader.id),
                    plan_path: None,
                    normalized_plan_path: None,
                },
                Vec::new(),
                false,
            )
            .expect("reconcile");

        let reconciled_worker = result
            .workers
            .iter()
            .find(|item| item.id == worker.id)
            .expect("worker result");
        assert_eq!(reconciled_worker.status, TaskBindingStatus::Waiting);
        assert_eq!(reconciled_worker.pane_id.as_deref(), Some("pane-worker"));
        assert!(!reconciled_worker.is_live);
    }
}
