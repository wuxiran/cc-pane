use serde::Serialize;
use std::fs;
use std::path::PathBuf;

/// Plan 归档服务 - 管理项目下 .ccpanes/plans/ 的已归档 plan 文件
pub struct PlanService;

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
}

impl PlanService {
    pub fn new() -> Self {
        Self
    }

    /// 获取项目的 plans 归档目录
    fn plans_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".ccpanes").join("plans")
    }

    /// 列出项目下所有已归档的 plan 文件，按时间倒序
    pub fn list_plans(&self, project_path: &str) -> Result<Vec<PlanEntry>, String> {
        let dir = Self::plans_dir(project_path);
        if !dir.exists() {
            return Ok(vec![]);
        }

        let mut entries: Vec<PlanEntry> = fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read plans directory: {}", e))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .map(|ext| ext == "md")
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let file_name = entry.file_name().to_string_lossy().to_string();
                let parsed = Self::parse_file_name(&file_name);
                Some(PlanEntry {
                    file_name,
                    original_name: parsed.0,
                    session_id: parsed.1,
                    archived_at: parsed.2,
                    size: metadata.len(),
                })
            })
            .collect();

        // 按归档时间倒序
        entries.sort_by_cached_key(|entry| std::cmp::Reverse(entry.archived_at.clone()));

        Ok(entries)
    }

    /// 读取指定 plan 文件的内容
    pub fn get_plan_content(&self, project_path: &str, file_name: &str) -> Result<String, String> {
        // 安全检查：防止路径遍历
        if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            return Err("Invalid file name".to_string());
        }

        let path = Self::plans_dir(project_path).join(file_name);
        if !path.exists() {
            return Err("Plan file not found".to_string());
        }

        fs::read_to_string(&path).map_err(|e| format!("Failed to read plan file: {}", e))
    }

    /// 删除指定的 plan 归档文件
    pub fn delete_plan(&self, project_path: &str, file_name: &str) -> Result<(), String> {
        // 安全检查：防止路径遍历
        if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            return Err("Invalid file name".to_string());
        }

        let path = Self::plans_dir(project_path).join(file_name);
        if !path.exists() {
            return Err("Plan file not found".to_string());
        }

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

impl Default for PlanService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project_with_plans(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        let plans = dir.path().join(".ccpanes").join("plans");
        fs::create_dir_all(&plans).expect("create plans dir");
        for (name, content) in files {
            fs::write(plans.join(name), content).expect("write plan file");
        }
        dir
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
        let dir = TempDir::new().expect("temp dir");
        let svc = PlanService::new();
        let entries = svc
            .list_plans(dir.path().to_str().unwrap())
            .expect("list ok");
        assert!(entries.is_empty());
    }

    #[test]
    fn list_plans_filters_md_and_sorts_desc_by_archived_at() {
        let dir = project_with_plans(&[
            ("a1b2c3d4_20260101_090000_old.md", "old"),
            ("a1b2c3d4_20260301_090000_new.md", "new content"),
            ("notes.txt", "ignored"),
        ]);
        let svc = PlanService::new();
        let entries = svc
            .list_plans(dir.path().to_str().unwrap())
            .expect("list ok");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].original_name, "new.md");
        assert_eq!(entries[1].original_name, "old.md");
        assert_eq!(entries[0].size, "new content".len() as u64);
    }

    // ---- get_plan_content / delete_plan ----

    #[test]
    fn get_plan_content_reads_file() {
        let dir = project_with_plans(&[("a1b2c3d4_20260215_143052_p.md", "# Plan body")]);
        let svc = PlanService::new();
        let content = svc
            .get_plan_content(
                dir.path().to_str().unwrap(),
                "a1b2c3d4_20260215_143052_p.md",
            )
            .expect("read ok");
        assert_eq!(content, "# Plan body");
    }

    #[test]
    fn get_plan_content_rejects_path_traversal() {
        let dir = project_with_plans(&[]);
        let svc = PlanService::new();
        for bad in ["../secret.md", "a/b.md", "a\\b.md", "..\\up.md"] {
            let err = svc
                .get_plan_content(dir.path().to_str().unwrap(), bad)
                .expect_err("must reject traversal");
            assert_eq!(err, "Invalid file name");
        }
    }

    #[test]
    fn get_plan_content_missing_file_errors() {
        let dir = project_with_plans(&[]);
        let svc = PlanService::new();
        let err = svc
            .get_plan_content(dir.path().to_str().unwrap(), "nope.md")
            .expect_err("missing file");
        assert_eq!(err, "Plan file not found");
    }

    #[test]
    fn delete_plan_removes_file_and_rejects_traversal() {
        let dir = project_with_plans(&[("a1b2c3d4_20260215_143052_p.md", "x")]);
        let svc = PlanService::new();
        let project = dir.path().to_str().unwrap().to_string();

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
