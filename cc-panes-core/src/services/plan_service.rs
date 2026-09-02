use crate::services::WorkspaceService;
use crate::utils::{project_dirs, AppPaths};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Plan 归档浏览（docs/98 第三批：plans 归拢到工作空间层）。
///
/// 读取顺序 = hook 的写入顺序：
/// 1. `~/.cc-panes/workspaces/<name>/plans/` —— 项目所属工作空间（hook 经
///    `CC_PANES_PLANS_DIR` 写入）
/// 2. `<project>/.ccpanes/.cache/plans/` —— 不属于任何工作空间时的机器本地兜底
/// 3. `<project>/.ccpanes/plans/` —— 0.12.10 前的旧位置，只读
pub struct PlanService {
    app_paths: Arc<AppPaths>,
    workspace_service: Arc<WorkspaceService>,
}

pub const PROJECT_PLANS_CACHE_NAME: &str = "plans";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanLayer {
    Workspace,
    ProjectCache,
    ProjectLegacy,
}

/// 已归档 plan 文件的元数据
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// 完整文件名
    pub file_name: String,
    /// 原始 plan 名（去掉 session 前缀和时间戳）
    pub original_name: String,
    /// 8 字符 session ID 前缀
    pub session_id: String,
    /// 归档时间（从时间戳解析的 ISO 格式）
    pub archived_at: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 文件来自哪一层
    pub layer: PlanLayer,
}

impl PlanService {
    pub fn new(app_paths: Arc<AppPaths>, workspace_service: Arc<WorkspaceService>) -> Self {
        Self {
            app_paths,
            workspace_service,
        }
    }

    fn workspace_name_for_project(&self, project_path: &str) -> Option<String> {
        let target = Path::new(project_path);
        self.workspace_service
            .list_workspaces()
            .ok()?
            .into_iter()
            .find(|ws| ws.projects.iter().any(|p| Path::new(&p.path) == target))
            .map(|ws| ws.name)
    }

    /// 该项目 plan 可能存在的目录，按优先级。
    pub fn plan_dirs(&self, project_path: &str) -> Vec<(PlanLayer, PathBuf)> {
        let project = Path::new(project_path);
        let mut dirs = Vec::with_capacity(3);
        if let Some(name) = self.workspace_name_for_project(project_path) {
            dirs.push((
                PlanLayer::Workspace,
                self.app_paths.workspace_plans_dir(&name),
            ));
        }
        dirs.push((
            PlanLayer::ProjectCache,
            project_dirs::cache_entry(project, PROJECT_PLANS_CACHE_NAME),
        ));
        dirs.push((
            PlanLayer::ProjectLegacy,
            project_dirs::legacy_entry(project, PROJECT_PLANS_CACHE_NAME),
        ));
        dirs
    }

    fn validate_file_name(file_name: &str) -> Result<(), String> {
        if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            return Err("Invalid file name".to_string());
        }
        Ok(())
    }

    fn locate(&self, project_path: &str, file_name: &str) -> Result<PathBuf, String> {
        Self::validate_file_name(file_name)?;
        self.plan_dirs(project_path)
            .into_iter()
            .map(|(_, dir)| dir.join(file_name))
            .find(|path| path.is_file())
            .ok_or_else(|| "Plan file not found".to_string())
    }

    /// 列出项目所有层的已归档 plan 文件，按时间倒序；同名文件以高优先级层为准。
    pub fn list_plans(&self, project_path: &str) -> Result<Vec<PlanEntry>, String> {
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        for (layer, dir) in self.plan_dirs(project_path) {
            if !dir.is_dir() {
                continue;
            }
            let read =
                fs::read_dir(&dir).map_err(|e| format!("Failed to read plans directory: {}", e))?;
            for entry in read.filter_map(|entry| entry.ok()) {
                let path = entry.path();
                if path.extension().map(|ext| ext == "md") != Some(true) {
                    continue;
                }
                let file_name = entry.file_name().to_string_lossy().to_string();
                if !seen.insert(file_name.clone()) {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                let parsed = Self::parse_file_name(&file_name);
                entries.push(PlanEntry {
                    file_name,
                    original_name: parsed.0,
                    session_id: parsed.1,
                    archived_at: parsed.2,
                    size: metadata.len(),
                    layer,
                });
            }
        }

        // 按归档时间倒序
        entries.sort_by_cached_key(|entry| std::cmp::Reverse(entry.archived_at.clone()));

        Ok(entries)
    }

    /// 读取指定 plan 文件的内容
    pub fn get_plan_content(&self, project_path: &str, file_name: &str) -> Result<String, String> {
        let path = self.locate(project_path, file_name)?;
        fs::read_to_string(&path).map_err(|e| format!("Failed to read plan file: {}", e))
    }

    /// 删除指定的 plan 归档文件
    pub fn delete_plan(&self, project_path: &str, file_name: &str) -> Result<(), String> {
        let path = self.locate(project_path, file_name)?;
        fs::remove_file(&path).map_err(|e| format!("Failed to delete plan file: {}", e))
    }

    /// 解析归档文件名，提取原始名、session ID、时间戳
    ///
    /// 格式: `{session_prefix}_{timestamp}_{original_name}`
    /// 例: `a1b2c3d4_20260215_143052_structured-kindling-canyon.md`
    /// 或无 session: `20260215_143052_structured-kindling-canyon.md`
    fn parse_file_name(file_name: &str) -> (String, String, String) {
        let parts: Vec<&str> = file_name.splitn(4, '_').collect();

        if parts.len() >= 4 {
            // 尝试解析为 session_timestamp_original 格式
            let maybe_session = parts[0];
            let maybe_date = parts[1];
            let maybe_time = parts[2];

            // 判断第一部分是否为 session ID（非纯数字，长度 8）
            if maybe_session.len() == 8
                && !maybe_session.chars().all(|c| c.is_ascii_digit())
                && maybe_date.len() == 8
                && maybe_date.chars().all(|c| c.is_ascii_digit())
            {
                let original = parts[3..].join("_");
                let archived_at = Self::parse_timestamp(maybe_date, maybe_time);
                return (original, maybe_session.to_string(), archived_at);
            }
        }

        if parts.len() >= 3 {
            // 尝试解析为 timestamp_original 格式（无 session）
            let maybe_date = parts[0];
            let maybe_time = parts[1];

            if maybe_date.len() == 8 && maybe_date.chars().all(|c| c.is_ascii_digit()) {
                let original = parts[2..].join("_");
                let archived_at = Self::parse_timestamp(maybe_date, maybe_time);
                return (original, String::new(), archived_at);
            }
        }

        // 无法解析，返回原始文件名
        (file_name.to_string(), String::new(), String::new())
    }

    /// 从日期和时间字符串解析为 ISO 格式
    fn parse_timestamp(date_str: &str, time_str: &str) -> String {
        if date_str.len() == 8 && time_str.len() == 6 {
            format!(
                "{}-{}-{}T{}:{}:{}",
                &date_str[..4],
                &date_str[4..6],
                &date_str[6..8],
                &time_str[..2],
                &time_str[2..4],
                &time_str[4..6],
            )
        } else {
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        _data: TempDir,
        project: TempDir,
        svc: PlanService,
    }

    impl Fixture {
        fn project_path(&self) -> String {
            self.project.path().to_string_lossy().to_string()
        }
    }

    fn fixture() -> Fixture {
        let data = TempDir::new().expect("data dir");
        let project = TempDir::new().expect("project dir");
        let app_paths = Arc::new(AppPaths::new(Some(
            data.path().to_string_lossy().to_string(),
        )));
        let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
        let svc = PlanService::new(app_paths, workspace_service);
        Fixture {
            _data: data,
            project,
            svc,
        }
    }

    fn write_plans(dir: &Path, files: &[(&str, &str)]) {
        fs::create_dir_all(dir).expect("create plans dir");
        for (name, content) in files {
            fs::write(dir.join(name), content).expect("write plan file");
        }
    }

    /// 旧位置 `<project>/.ccpanes/plans/`（只读兼容层）
    fn project_with_plans(files: &[(&str, &str)]) -> Fixture {
        let fx = fixture();
        write_plans(&fx.project.path().join(".ccpanes").join("plans"), files);
        fx
    }

    #[test]
    fn workspace_layer_wins_over_project_layers_and_dedups_by_name() {
        let fx = fixture();
        let project_path = fx.project_path();
        fx.svc
            .workspace_service
            .create_workspace("team", None)
            .expect("workspace");
        fx.svc
            .workspace_service
            .add_project("team", &project_path)
            .expect("add project");

        let ws_dir = fx.svc.app_paths.workspace_plans_dir("team");
        write_plans(
            &ws_dir,
            &[("a1b2c3d4_20260301_090000_shared.md", "workspace copy")],
        );
        write_plans(
            &project_dirs::cache_entry(fx.project.path(), "plans"),
            &[
                ("a1b2c3d4_20260301_090000_shared.md", "cache copy"),
                ("a1b2c3d4_20260201_090000_cache-only.md", "cache"),
            ],
        );
        write_plans(
            &fx.project.path().join(".ccpanes/plans"),
            &[("a1b2c3d4_20260101_090000_legacy-only.md", "legacy")],
        );

        let entries = fx.svc.list_plans(&project_path).expect("list");
        let names: Vec<_> = entries.iter().map(|e| e.original_name.as_str()).collect();
        assert_eq!(names, vec!["shared.md", "cache-only.md", "legacy-only.md"]);
        assert_eq!(entries[0].layer, PlanLayer::Workspace);
        assert_eq!(entries[1].layer, PlanLayer::ProjectCache);
        assert_eq!(entries[2].layer, PlanLayer::ProjectLegacy);
        assert_eq!(
            fx.svc
                .get_plan_content(&project_path, "a1b2c3d4_20260301_090000_shared.md")
                .unwrap(),
            "workspace copy"
        );
        // 删除按同样的顺序定位：删的是工作空间那份，缓存那份随后浮上来
        fx.svc
            .delete_plan(&project_path, "a1b2c3d4_20260301_090000_shared.md")
            .unwrap();
        assert_eq!(
            fx.svc
                .get_plan_content(&project_path, "a1b2c3d4_20260301_090000_shared.md")
                .unwrap(),
            "cache copy"
        );
    }

    #[test]
    fn project_without_workspace_has_no_workspace_dir() {
        let fx = fixture();
        let dirs = fx.svc.plan_dirs(&fx.project_path());
        assert_eq!(dirs.len(), 2);
        assert_eq!(dirs[0].0, PlanLayer::ProjectCache);
        assert_eq!(dirs[1].0, PlanLayer::ProjectLegacy);
    }

    // ---- parse_file_name ----

    #[test]
    fn parse_file_name_with_session_prefix() {
        let (original, session, archived_at) =
            PlanService::parse_file_name("a1b2c3d4_20260215_143052_structured-kindling-canyon.md");
        assert_eq!(original, "structured-kindling-canyon.md");
        assert_eq!(session, "a1b2c3d4");
        assert_eq!(archived_at, "2026-02-15T14:30:52");
    }

    #[test]
    fn parse_file_name_keeps_underscores_in_original_name() {
        let (original, session, _) =
            PlanService::parse_file_name("a1b2c3d4_20260215_143052_my_plan_v2.md");
        assert_eq!(original, "my_plan_v2.md");
        assert_eq!(session, "a1b2c3d4");
    }

    #[test]
    fn parse_file_name_without_session_prefix() {
        let (original, session, archived_at) =
            PlanService::parse_file_name("20260215_143052_plan.md");
        assert_eq!(original, "plan.md");
        assert_eq!(session, "");
        assert_eq!(archived_at, "2026-02-15T14:30:52");
    }

    #[test]
    fn parse_file_name_unparseable_returns_as_is() {
        let (original, session, archived_at) = PlanService::parse_file_name("random-plan.md");
        assert_eq!(original, "random-plan.md");
        assert_eq!(session, "");
        assert_eq!(archived_at, "");
    }

    #[test]
    fn parse_timestamp_rejects_bad_lengths() {
        assert_eq!(
            PlanService::parse_timestamp("20260215", "143052"),
            "2026-02-15T14:30:52"
        );
        assert_eq!(PlanService::parse_timestamp("2026", "143052"), "");
        assert_eq!(PlanService::parse_timestamp("20260215", "1430"), "");
    }

    // ---- list_plans ----

    #[test]
    fn list_plans_returns_empty_when_dir_missing() {
        let fx = fixture();
        let entries = fx.svc.list_plans(&fx.project_path()).expect("list ok");
        assert!(entries.is_empty());
    }

    #[test]
    fn list_plans_filters_md_and_sorts_desc_by_archived_at() {
        let dir = project_with_plans(&[
            ("a1b2c3d4_20260101_090000_old.md", "old"),
            ("a1b2c3d4_20260301_090000_new.md", "new content"),
            ("notes.txt", "ignored"),
        ]);
        let svc = &dir.svc;
        let entries = svc.list_plans(&dir.project_path()).expect("list ok");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].original_name, "new.md");
        assert_eq!(entries[1].original_name, "old.md");
        assert_eq!(entries[0].size, "new content".len() as u64);
    }

    // ---- get_plan_content / delete_plan ----

    #[test]
    fn get_plan_content_reads_file() {
        let dir = project_with_plans(&[("a1b2c3d4_20260215_143052_p.md", "# Plan body")]);
        let svc = &dir.svc;
        let content = svc
            .get_plan_content(&dir.project_path(), "a1b2c3d4_20260215_143052_p.md")
            .expect("read ok");
        assert_eq!(content, "# Plan body");
    }

    #[test]
    fn get_plan_content_rejects_path_traversal() {
        let dir = project_with_plans(&[]);
        let svc = &dir.svc;
        for bad in ["../secret.md", "a/b.md", "a\\b.md", "..\\up.md"] {
            let err = svc
                .get_plan_content(&dir.project_path(), bad)
                .expect_err("must reject traversal");
            assert_eq!(err, "Invalid file name");
        }
    }

    #[test]
    fn get_plan_content_missing_file_errors() {
        let dir = project_with_plans(&[]);
        let svc = &dir.svc;
        let err = svc
            .get_plan_content(&dir.project_path(), "nope.md")
            .expect_err("missing file");
        assert_eq!(err, "Plan file not found");
    }

    #[test]
    fn delete_plan_removes_file_and_rejects_traversal() {
        let dir = project_with_plans(&[("a1b2c3d4_20260215_143052_p.md", "x")]);
        let svc = &dir.svc;
        let project = dir.project_path();

        let err = svc
            .delete_plan(&project, "../p.md")
            .expect_err("must reject traversal");
        assert_eq!(err, "Invalid file name");

        svc.delete_plan(&project, "a1b2c3d4_20260215_143052_p.md")
            .expect("delete ok");
        assert!(svc.list_plans(&project).expect("list ok").is_empty());

        let err = svc
            .delete_plan(&project, "a1b2c3d4_20260215_143052_p.md")
            .expect_err("already deleted");
        assert_eq!(err, "Plan file not found");
    }
}
