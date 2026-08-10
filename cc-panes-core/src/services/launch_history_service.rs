use crate::repository::{HistoryRepository, LaunchRecord, SessionStartedUpsertResult};
use std::sync::Arc;

const MAX_MODEL_ID_CHARS: usize = 256;

fn validate_model_id(model_id: Option<&str>) -> Result<(), String> {
    if model_id.is_some_and(|value| {
        value.chars().count() > MAX_MODEL_ID_CHARS
            || value.chars().any(|character| character.is_control())
    }) {
        return Err(format!(
            "launch history model id must be at most {MAX_MODEL_ID_CHARS} characters and contain no control characters"
        ));
    }
    Ok(())
}

/// 启动历史 Service - 封装对 HistoryRepository 的操作
pub struct LaunchHistoryService {
    repo: Arc<HistoryRepository>,
}

pub struct CreatedLaunchHistory<'a> {
    pub launch_id: &'a str,
    pub project_name: &'a str,
    pub project_path: &'a str,
    pub pty_session_id: &'a str,
    pub cli_tool: &'a str,
    pub runtime_kind: &'a str,
    pub wsl_distro: Option<&'a str>,
    pub workspace_name: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub launch_cwd: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub model_id: Option<&'a str>,
    pub provider_selection: Option<&'a str>,
    pub launch_profile_id: Option<&'a str>,
    pub workspace_snapshot_id: Option<&'a str>,
}

impl LaunchHistoryService {
    pub fn new(repo: Arc<HistoryRepository>) -> Self {
        Self { repo }
    }

    /// 添加启动记录，返回记录 ID
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &self,
        project_id: &str,
        project_name: &str,
        project_path: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        workspace_name: Option<&str>,
        workspace_path: Option<&str>,
        launch_cwd: Option<&str>,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        provider_selection: Option<&str>,
        launch_profile_id: Option<&str>,
        workspace_snapshot_id: Option<&str>,
    ) -> Result<i64, String> {
        validate_model_id(model_id)?;
        self.repo.add(
            project_id,
            project_name,
            project_path,
            cli_tool,
            runtime_kind,
            wsl_distro,
            workspace_name,
            workspace_path,
            launch_cwd,
            provider_id,
            model_id,
            provider_selection,
            launch_profile_id,
            workspace_snapshot_id,
        )
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        self.repo.list(limit)
    }

    /// 同 `add`，但在写入时就把 `pty_session_id` 设上。
    /// 用于 MCP `launch_task` 由后端直接创建 PTY 的路径，避免 hook 上报前
    /// `find_by_launch_id` 拿到 `pty_session_id = NULL` 的竞态。
    #[allow(clippy::too_many_arguments)]
    pub fn add_with_pty_session(
        &self,
        project_id: &str,
        project_name: &str,
        project_path: &str,
        pty_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        workspace_name: Option<&str>,
        workspace_path: Option<&str>,
        launch_cwd: Option<&str>,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        provider_selection: Option<&str>,
        launch_profile_id: Option<&str>,
        workspace_snapshot_id: Option<&str>,
    ) -> Result<i64, String> {
        validate_model_id(model_id)?;
        self.repo.add_with_pty_session(
            project_id,
            project_name,
            project_path,
            pty_session_id,
            cli_tool,
            runtime_kind,
            wsl_distro,
            workspace_name,
            workspace_path,
            launch_cwd,
            provider_id,
            model_id,
            provider_selection,
            launch_profile_id,
            workspace_snapshot_id,
        )
    }

    /// 按项目路径获取启动记录（SQL 层路径规范化过滤）
    pub fn list_by_project(
        &self,
        project_path: &str,
        limit: usize,
    ) -> Result<Vec<LaunchRecord>, String> {
        self.repo.list_by_project(project_path, limit)
    }

    /// 更新 Claude Session ID
    pub fn update_session_id(&self, id: i64, resume_session_id: &str) -> Result<(), String> {
        self.repo.update_session_id(id, resume_session_id)
    }

    /// 标记 resume id 的来源（issued / osc-title / backfill / rescue / manual）
    pub fn update_resume_source(&self, id: i64, source: &str) -> Result<(), String> {
        self.repo.update_resume_source(id, source)
    }

    /// 按 pty_session_id 写入 resume id 及来源（OSC 标题捕获等确定性通道）
    pub fn update_resume_session_with_source_by_pty(
        &self,
        pty_session_id: &str,
        resume_session_id: &str,
        source: &str,
    ) -> Result<Option<i64>, String> {
        self.repo
            .update_resume_session_with_source_by_pty(pty_session_id, resume_session_id, source)
            .map(|result| result.map(|selected| selected.record_id))
    }

    /// Source-aware PTY binding that also returns the value retained by transaction arbitration.
    pub fn update_resume_session_with_source_by_pty_with_result(
        &self,
        pty_session_id: &str,
        resume_session_id: &str,
        source: &str,
    ) -> Result<Option<SessionStartedUpsertResult>, String> {
        self.repo.update_resume_session_with_source_by_pty(
            pty_session_id,
            resume_session_id,
            source,
        )
    }

    pub fn bind_pty_session(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        cli_tool: &str,
        model_id: Option<&str>,
        provider_id: Option<&str>,
    ) -> Result<Option<i64>, String> {
        validate_model_id(model_id)?;
        self.repo.bind_pty_session(
            launch_id,
            pty_session_id,
            cli_tool,
            model_id,
            provider_id,
        )
    }

    pub fn bind_or_add_created_session(
        &self,
        record: CreatedLaunchHistory<'_>,
    ) -> Result<i64, String> {
        if let Some(id) = self.bind_pty_session(
            record.launch_id,
            record.pty_session_id,
            record.cli_tool,
            record.model_id,
            record.provider_id,
        )? {
            return Ok(id);
        }

        self.add_with_pty_session(
            record.launch_id,
            record.project_name,
            record.project_path,
            record.pty_session_id,
            record.cli_tool,
            record.runtime_kind,
            record.wsl_distro,
            record.workspace_name,
            record.workspace_path,
            record.launch_cwd,
            record.provider_id,
            record.model_id,
            record.provider_selection,
            record.launch_profile_id,
            record.workspace_snapshot_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_session_started(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        resume_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        launch_cwd: Option<&str>,
    ) -> Result<Option<i64>, String> {
        self.repo.update_session_started(
            launch_id,
            pty_session_id,
            resume_session_id,
            cli_tool,
            runtime_kind,
            wsl_distro,
            launch_cwd,
        )
    }

    /// 回填会话启动信息（upsert）：有记录则更新，无记录则创建带 pty+resume 的完整记录。
    /// 用于 GUI 经 TabBar 新建等不写 launch_history 的启动路径，使 Codex 也能 reload 恢复。
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_session_started(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        resume_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        launch_cwd: Option<&str>,
        project_path: &str,
        project_name: &str,
        workspace_path: Option<&str>,
    ) -> Result<i64, String> {
        self.repo.upsert_session_started(
            launch_id,
            pty_session_id,
            resume_session_id,
            cli_tool,
            runtime_kind,
            wsl_distro,
            launch_cwd,
            project_path,
            project_name,
            workspace_path,
        )
    }

    /// Source-aware upsert. The repository arbitrates source priority and CLI ownership
    /// in the same transaction that binds the PTY and writes the resume id.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_session_started_with_source(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        resume_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        launch_cwd: Option<&str>,
        project_path: &str,
        project_name: &str,
        workspace_path: Option<&str>,
        resume_source: &str,
    ) -> Result<SessionStartedUpsertResult, String> {
        self.repo.upsert_session_started_with_source(
            launch_id,
            pty_session_id,
            resume_session_id,
            cli_tool,
            runtime_kind,
            wsl_distro,
            launch_cwd,
            project_path,
            project_name,
            workspace_path,
            resume_source,
        )
    }

    /// 更新最后 Prompt
    pub fn update_last_prompt(&self, id: i64, last_prompt: &str) -> Result<(), String> {
        self.repo.update_last_prompt(id, last_prompt)
    }

    pub fn update_last_prompt_by_pty_session_id(
        &self,
        pty_session_id: &str,
        last_prompt: &str,
    ) -> Result<Option<i64>, String> {
        self.repo
            .update_last_prompt_by_pty_session_id(pty_session_id, last_prompt)
    }

    /// 更新已有会话记录的时间戳，返回记录 ID（不存在则返回 None）
    pub fn touch_by_session_id(&self, resume_session_id: &str) -> Result<Option<i64>, String> {
        self.repo.touch_by_session_id(resume_session_id)
    }

    pub fn find_by_pty_session_id(
        &self,
        pty_session_id: &str,
    ) -> Result<Option<crate::repository::LaunchRecord>, String> {
        self.repo.find_by_pty_session_id(pty_session_id)
    }

    pub fn find_by_resume_session_id(
        &self,
        resume_session_id: &str,
    ) -> Result<Option<crate::repository::LaunchRecord>, String> {
        self.repo.find_by_resume_session_id(resume_session_id)
    }

    pub fn find_by_launch_id(
        &self,
        launch_id: &str,
    ) -> Result<Option<crate::repository::LaunchRecord>, String> {
        self.repo.find_by_launch_id(launch_id)
    }

    /// 删除单条启动记录
    pub fn delete(&self, id: i64) -> Result<(), String> {
        self.repo.delete_by_id(id)
    }

    /// 清空启动记录
    pub fn clear(&self) -> Result<(), String> {
        self.repo.clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Database;

    fn service() -> LaunchHistoryService {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        LaunchHistoryService::new(Arc::new(HistoryRepository::new(db)))
    }

    /// 以最少参数添加一条记录
    fn add_record(svc: &LaunchHistoryService, project_id: &str, project_path: &str) -> i64 {
        svc.add(
            project_id,
            "proj",
            project_path,
            "claude",
            "local",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("add record")
    }

    #[test]
    fn add_then_list_returns_record_with_defaults() {
        let svc = service();
        let id = add_record(&svc, "p1", "D:\\work\\proj");
        assert!(id > 0);

        let records = svc.list(10).expect("list ok");
        assert_eq!(records.len(), 1);
        let rec = &records[0];
        assert_eq!(rec.id, id);
        assert_eq!(rec.project_id, "p1");
        assert_eq!(rec.cli_tool, "claude");
        assert_eq!(rec.runtime_kind, "local");
        assert!(rec.pty_session_id.is_none());
        assert!(rec.resume_session_id.is_none());
    }

    #[test]
    fn add_preserves_provider_and_model_ids() {
        let svc = service();

        svc.add(
            "launch-model-a",
            "proj",
            "/tmp/proj",
            "claude",
            "local",
            None,
            None,
            None,
            None,
            Some("provider-a"),
            Some("claude-sonnet-4-5"),
            None,
            None,
            None,
        )
        .expect("add record");

        let record = &svc.list(1).expect("list ok")[0];
        assert_eq!(record.provider_id.as_deref(), Some("provider-a"));
        assert_eq!(record.model_id.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn add_rejects_invalid_model_ids_without_persisting() {
        let invalid_model_ids = ["x".repeat(257), "model\nid".to_string()];

        for (index, model_id) in invalid_model_ids.iter().enumerate() {
            let svc = service();
            let result = svc.add(
                &format!("launch-invalid-model-{index}"),
                "proj",
                "/tmp/proj",
                "claude",
                "local",
                None,
                None,
                None,
                None,
                Some("provider-a"),
                Some(model_id),
                None,
                None,
                None,
            );

            assert!(result.is_err(), "model id should be rejected: {model_id:?}");
            assert!(svc.list(1).expect("list history").is_empty());
        }
    }

    #[test]
    fn bind_pty_session_persists_provider_id_on_existing_launch() {
        let svc = service();

        // 先 add 一条带默认值的 launch 行（provider_id 留空）
        let launch_id = add_record(&svc, "p-bind-provider", "/tmp/proj");
        let before = &svc.list(10).expect("list")[0];
        assert_eq!(before.id, launch_id);
        assert!(before.provider_id.is_none());
        assert!(before.pty_session_id.is_none());

        // PTY 出生后 bind 上来，**关键**：bind 路径必须把 provider_id 写进去
        let bound = svc
            .bind_pty_session(
                "p-bind-provider",
                "pty-123",
                "claude",
                Some("claude-sonnet-4-5"),
                Some("provider-z"),
            )
            .expect("bind ok")
            .expect("matched a launch row");
        assert_eq!(bound, launch_id);

        let after = &svc.list(10).expect("list")[0];
        assert_eq!(after.pty_session_id.as_deref(), Some("pty-123"));
        assert_eq!(
            after.provider_id.as_deref(),
            Some("provider-z"),
            "bind_pty_session 路径必须把 provider_id 写进 launch_history，否则后端 usage 服务读不到 Provider contextWindowTokens"
        );
        assert_eq!(after.model_id.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn list_by_project_normalizes_slashes_and_case() {
        let svc = service();
        add_record(&svc, "p1", "D:\\Work\\Proj");
        add_record(&svc, "p2", "D:/other/proj");

        // 反斜杠库内记录，用正斜杠 + 不同大小写查询也要命中
        let hits = svc.list_by_project("d:/work/proj", 10).expect("list ok");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].project_id, "p1");

        let none = svc.list_by_project("d:/no/match", 10).expect("list ok");
        assert!(none.is_empty());
    }

    #[test]
    fn add_with_pty_session_findable_by_pty_id() {
        let svc = service();
        svc.add_with_pty_session(
            "p1",
            "proj",
            "/tmp/proj",
            "pty-1",
            "codex",
            "wsl",
            Some("Ubuntu"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None, // workspace_snapshot_id
        )
        .expect("add ok");

        let rec = svc
            .find_by_pty_session_id("pty-1")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(rec.project_id, "p1");
        assert_eq!(rec.cli_tool, "codex");
        assert_eq!(rec.wsl_distro.as_deref(), Some("Ubuntu"));

        assert!(svc
            .find_by_pty_session_id("no-such")
            .expect("find ok")
            .is_none());
    }

    #[test]
    fn bind_pty_session_requires_matching_launch_and_cli_tool() {
        let svc = service();
        add_record(&svc, "launch-claude", "/tmp/claude");
        svc.add(
            "launch-codex",
            "codex-project",
            "/tmp/codex",
            "codex",
            "wsl",
            Some("Ubuntu"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("add codex record");

        assert!(svc
            .bind_pty_session("launch-codex", "pty-codex", "claude", None, None)
            .expect("mismatch is not an error")
            .is_none());
        assert!(svc
            .find_by_pty_session_id("pty-codex")
            .expect("find")
            .is_none());

        let id = svc
            .bind_pty_session("launch-codex", "pty-codex", "codex", None, None)
            .expect("bind")
            .expect("record id");
        let record = svc
            .find_by_pty_session_id("pty-codex")
            .expect("find")
            .expect("record");
        assert_eq!(record.id, id);
        assert_eq!(record.project_id, "launch-codex");
        assert_eq!(record.cli_tool, "codex");
    }

    #[test]
    fn bind_or_add_created_session_inserts_missing_history_with_model() {
        let svc = service();

        let id = svc
            .bind_or_add_created_session(CreatedLaunchHistory {
                launch_id: "launch-fallback",
                project_name: "proj",
                project_path: "/tmp/proj",
                pty_session_id: "pty-fallback",
                cli_tool: "claude",
                runtime_kind: "local",
                wsl_distro: None,
                workspace_name: None,
                workspace_path: None,
                launch_cwd: Some("/tmp/proj"),
                provider_id: Some("provider-a"),
                model_id: Some("provider-default"),
                provider_selection: Some("inherit"),
                launch_profile_id: None,
                workspace_snapshot_id: None,
            })
            .expect("record created session");

        let record = svc
            .find_by_launch_id("launch-fallback")
            .expect("find history")
            .expect("history row");
        assert_eq!(record.id, id);
        assert_eq!(record.pty_session_id.as_deref(), Some("pty-fallback"));
        assert_eq!(record.model_id.as_deref(), Some("provider-default"));
    }

    #[test]
    fn update_session_id_and_resume_source_round_trip() {
        let svc = service();
        let id = add_record(&svc, "p1", "/tmp/proj");

        svc.update_session_id(id, "resume-uuid")
            .expect("set resume");
        svc.update_resume_source(id, "issued").expect("set source");

        let rec = svc
            .find_by_resume_session_id("resume-uuid")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(rec.id, id);
        assert_eq!(rec.resume_source.as_deref(), Some("issued"));

        assert!(svc
            .find_by_resume_session_id("unknown")
            .expect("find ok")
            .is_none());
    }

    #[test]
    fn update_session_started_none_when_launch_id_unknown() {
        let svc = service();
        let result = svc
            .update_session_started("ghost", "pty-x", "resume-x", "claude", "local", None, None)
            .expect("update ok");
        assert!(result.is_none());
    }

    #[test]
    fn update_last_prompt_by_pty_session_id_matches_and_misses() {
        let svc = service();
        svc.add_with_pty_session(
            "p1",
            "proj",
            "/tmp/proj",
            "pty-1",
            "claude",
            "local",
            None,
            None,
            None,
            None,
            None,
            None, // model_id
            None,
            None,
            None,
        )
        .expect("add ok");

        assert!(svc
            .update_last_prompt_by_pty_session_id("no-such", "hi")
            .expect("ok")
            .is_none());

        let id = svc
            .update_last_prompt_by_pty_session_id("pty-1", "fix the bug")
            .expect("ok")
            .expect("matched");
        assert!(id > 0);

        let rec = svc
            .find_by_pty_session_id("pty-1")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(rec.last_prompt.as_deref(), Some("fix the bug"));
    }

    #[test]
    fn update_last_prompt_by_id() {
        let svc = service();
        let id = add_record(&svc, "p1", "/tmp/proj");
        svc.update_last_prompt(id, "prompt text")
            .expect("update ok");

        let rec = &svc.list(1).expect("list ok")[0];
        assert_eq!(rec.last_prompt.as_deref(), Some("prompt text"));
    }

    #[test]
    fn touch_by_session_id_updates_timestamp_or_returns_none() {
        let svc = service();
        let id = add_record(&svc, "p1", "/tmp/proj");
        svc.update_session_id(id, "resume-1").expect("set resume");

        assert!(svc.touch_by_session_id("unknown").expect("ok").is_none());
        assert_eq!(svc.touch_by_session_id("resume-1").expect("ok"), Some(id));
    }

    #[test]
    fn delete_and_clear_remove_records() {
        let svc = service();
        let id1 = add_record(&svc, "p1", "/tmp/a");
        add_record(&svc, "p2", "/tmp/b");

        svc.delete(id1).expect("delete ok");
        let remaining = svc.list(10).expect("list ok");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].project_id, "p2");

        svc.clear().expect("clear ok");
        assert!(svc.list(10).expect("list ok").is_empty());
    }
}
