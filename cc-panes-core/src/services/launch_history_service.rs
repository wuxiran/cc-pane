use crate::repository::{HistoryRepository, LaunchRecord};
use std::sync::Arc;

/// 启动历史 Service - 封装对 HistoryRepository 的操作
pub struct LaunchHistoryService {
    repo: Arc<HistoryRepository>,
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
        provider_selection: Option<&str>,
        launch_profile_id: Option<&str>,
        workspace_snapshot_id: Option<&str>,
    ) -> Result<i64, String> {
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
        provider_selection: Option<&str>,
        launch_profile_id: Option<&str>,
        workspace_snapshot_id: Option<&str>,
    ) -> Result<i64, String> {
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
        self.repo.update_resume_session_with_source_by_pty(
            pty_session_id,
            resume_session_id,
            source,
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
