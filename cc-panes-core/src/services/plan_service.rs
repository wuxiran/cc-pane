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
        entries.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));

        Ok(entries)
    }

    /// 读取指定 plan 文件的内容
    pub fn get_plan_content(
        &self,
        project_path: &str,
        file_name: &str,
    ) -> Result<String, String> {
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
