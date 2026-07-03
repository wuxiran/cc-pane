use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::constants::journal::MAX_LINES;

/// 会话摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub title: String,
    pub summary: String,
    pub commits: Vec<String>,
    pub date: String,
}

/// Journal 索引信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalIndex {
    pub active_file: String,
    pub total_sessions: u32,
    pub last_active: String,
}

/// Journal 服务 - 管理会话日志
pub struct JournalService {
    workspaces_dir: PathBuf,
}

impl JournalService {
    pub fn new(workspaces_dir: PathBuf) -> Self {
        Self { workspaces_dir }
    }

    /// 根据 workspace 名称获取对应的目录路径
    fn workspace_path(&self, workspace_name: &str) -> String {
        self.workspaces_dir
            .join(workspace_name)
            .to_string_lossy()
            .to_string()
    }

    /// 添加会话摘要（按 workspace 名称）
    pub fn add_session_by_workspace(
        &self,
        workspace_name: &str,
        summary: SessionSummary,
    ) -> Result<u32, String> {
        let ws_path = self.workspace_path(workspace_name);
        self.add_session(&ws_path, summary)
    }

    /// 获取 journal 索引信息（按 workspace 名称）
    pub fn get_index_by_workspace(&self, workspace_name: &str) -> Result<JournalIndex, String> {
        let ws_path = self.workspace_path(workspace_name);
        self.get_index(&ws_path)
    }

    /// 获取最近的 journal 内容（按 workspace 名称）
    pub fn get_recent_journal_by_workspace(&self, workspace_name: &str) -> Result<String, String> {
        let ws_path = self.workspace_path(workspace_name);
        self.get_recent_journal(&ws_path)
    }

    /// 获取 journal 目录路径
    fn get_journal_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".ccpanes").join("journal")
    }

    /// 获取索引文件路径
    fn get_index_path(project_path: &str) -> PathBuf {
        Self::get_journal_dir(project_path).join("index.md")
    }

    /// 获取当前活跃的 journal 文件信息
    fn get_latest_journal_info(&self, project_path: &str) -> Result<(PathBuf, u32, usize), String> {
        let journal_dir = Self::get_journal_dir(project_path);

        let mut latest_num: i32 = -1;
        let mut latest_file: Option<PathBuf> = None;

        if let Ok(entries) = fs::read_dir(&journal_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("journal-") && name.ends_with(".md") {
                    if let Some(num_str) = name
                        .strip_prefix("journal-")
                        .and_then(|s| s.strip_suffix(".md"))
                    {
                        if let Ok(num) = num_str.parse::<i32>() {
                            if num > latest_num {
                                latest_num = num;
                                latest_file = Some(entry.path());
                            }
                        }
                    }
                }
            }
        }

        let file = latest_file.unwrap_or_else(|| journal_dir.join("journal-0.md"));
        let num = if latest_num < 0 { 0 } else { latest_num as u32 };
        let lines = if file.exists() {
            fs::read_to_string(&file)
                .map(|c| c.lines().count())
                .unwrap_or(0)
        } else {
            0
        };

        Ok((file, num, lines))
    }

    /// 获取当前会话数
    fn get_current_session_count(&self, project_path: &str) -> Result<u32, String> {
        let index_path = Self::get_index_path(project_path);
        if !index_path.exists() {
            return Ok(0);
        }

        let content = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read index.md: {}", e))?;

        for line in content.lines() {
            if line.contains("Total Sessions") {
                if let Some(num_str) = line.split(':').next_back() {
                    if let Ok(num) = num_str.trim().parse::<u32>() {
                        return Ok(num);
                    }
                }
            }
        }

        Ok(0)
    }

    /// 生成会话内容
    fn generate_session_content(&self, session_num: u32, summary: &SessionSummary) -> String {
        let commits_table = if summary.commits.is_empty() {
            "(no commits - planning session)".to_string()
        } else {
            let mut table = "| Hash | Message |\n|------|---------|".to_string();
            for commit in &summary.commits {
                table.push_str(&format!("\n| `{}` | (see git log) |", commit));
            }
            table
        };

        format!(
            r#"
## Session {}: {}

**Date**: {}
**Task**: {}

### Summary

{}

### Git Commits

{}

### Status

[OK] **Completed**

---
"#,
            session_num, summary.title, summary.date, summary.title, summary.summary, commits_table
        )
    }

    /// 创建新的 journal 文件
    fn create_new_journal_file(&self, project_path: &str, num: u32) -> Result<PathBuf, String> {
        let journal_dir = Self::get_journal_dir(project_path);
        let new_file = journal_dir.join(format!("journal-{}.md", num));
        let today = Local::now().format("%Y-%m-%d").to_string();

        let content = format!(
            r#"# Session Journal (Part {})

> Continuation from `journal-{}.md` (archived at ~{} lines)
> Started: {}
> Managed by CC-Panes

---
"#,
            num,
            num - 1,
            MAX_LINES,
            today
        );

        fs::write(&new_file, content)
            .map_err(|e| format!("Failed to create journal file: {}", e))?;

        Ok(new_file)
    }

    /// 更新索引文件
    fn update_index(
        &self,
        project_path: &str,
        session_num: u32,
        title: &str,
        commits: &[String],
        active_file: &str,
    ) -> Result<(), String> {
        let index_path = Self::get_index_path(project_path);
        let today = Local::now().format("%Y-%m-%d").to_string();

        if !index_path.exists() {
            return Err("index.md does not exist".to_string());
        }

        let content = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read index.md: {}", e))?;

        let commits_display = if commits.is_empty() {
            "-".to_string()
        } else {
            commits
                .iter()
                .map(|c| format!("`{}`", c))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let mut new_content = String::new();
        let mut in_current_status = false;
        let mut in_session_history = false;
        let mut header_written = false;

        for line in content.lines() {
            if line.contains("@@@auto:current-status") {
                new_content.push_str(line);
                new_content.push('\n');
                in_current_status = true;
                new_content.push_str(&format!("- **Active File**: `{}`\n", active_file));
                new_content.push_str(&format!("- **Total Sessions**: {}\n", session_num));
                new_content.push_str(&format!("- **Last Active**: {}\n", today));
                continue;
            }

            if line.contains("@@@/auto:current-status") {
                in_current_status = false;
                new_content.push_str(line);
                new_content.push('\n');
                continue;
            }

            if in_current_status {
                continue;
            }

            if line.contains("@@@auto:session-history") {
                new_content.push_str(line);
                new_content.push('\n');
                in_session_history = true;
                continue;
            }

            if line.contains("@@@/auto:session-history") {
                in_session_history = false;
                new_content.push_str(line);
                new_content.push('\n');
                continue;
            }

            if in_session_history {
                new_content.push_str(line);
                new_content.push('\n');
                if line.starts_with("|---") && !header_written {
                    new_content.push_str(&format!(
                        "| {} | {} | {} | {} |\n",
                        session_num, today, title, commits_display
                    ));
                    header_written = true;
                }
                continue;
            }

            new_content.push_str(line);
            new_content.push('\n');
        }

        fs::write(&index_path, new_content)
            .map_err(|e| format!("Failed to write index.md: {}", e))?;

        Ok(())
    }

    /// 添加会话摘要
    pub fn add_session(&self, project_path: &str, summary: SessionSummary) -> Result<u32, String> {
        let journal_dir = Self::get_journal_dir(project_path);

        // 确保目录存在
        fs::create_dir_all(&journal_dir)
            .map_err(|e| format!("Failed to create journal directory: {}", e))?;

        // 获取当前 journal 信息
        let (current_file, current_num, current_lines) =
            self.get_latest_journal_info(project_path)?;
        let current_session = self.get_current_session_count(project_path)?;
        let new_session = current_session + 1;

        // 生成会话内容
        let session_content = self.generate_session_content(new_session, &summary);
        let content_lines = session_content.lines().count();

        // 确定目标文件
        let (target_file, target_num) = if current_lines + content_lines > MAX_LINES {
            let new_num = current_num + 1;
            let new_file = self.create_new_journal_file(project_path, new_num)?;
            (new_file, new_num)
        } else {
            (current_file, current_num)
        };

        // 追加内容
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target_file)
            .map_err(|e| format!("Failed to open journal file: {}", e))?;

        use std::io::Write;
        file.write_all(session_content.as_bytes())
            .map_err(|e| format!("Failed to write journal: {}", e))?;

        // 更新索引
        let active_file = format!("journal-{}.md", target_num);
        self.update_index(
            project_path,
            new_session,
            &summary.title,
            &summary.commits,
            &active_file,
        )?;

        Ok(new_session)
    }

    /// 获取 journal 索引信息
    pub fn get_index(&self, project_path: &str) -> Result<JournalIndex, String> {
        let (_, num, _) = self.get_latest_journal_info(project_path)?;
        let total = self.get_current_session_count(project_path)?;
        let today = Local::now().format("%Y-%m-%d").to_string();

        Ok(JournalIndex {
            active_file: format!("journal-{}.md", num),
            total_sessions: total,
            last_active: today,
        })
    }

    /// 获取最近的 journal 内容
    pub fn get_recent_journal(&self, project_path: &str) -> Result<String, String> {
        let (file, _, _) = self.get_latest_journal_info(project_path)?;

        if !file.exists() {
            return Ok(String::new());
        }

        fs::read_to_string(&file).map_err(|e| format!("Failed to read journal: {}", e))
    }
}

impl Default for JournalService {
    fn default() -> Self {
        Self::new(PathBuf::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::project_context_service::ProjectContextService;
    use tempfile::TempDir;

    fn summary(title: &str, commits: Vec<String>) -> SessionSummary {
        SessionSummary {
            title: title.to_string(),
            summary: format!("summary of {}", title),
            commits,
            date: "2026-07-03".to_string(),
        }
    }

    /// 初始化 .ccpanes/journal（含带自动区块标记的 index.md）的项目目录
    fn init_project() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        ProjectContextService::new()
            .init_ccpanes(dir.path().to_str().unwrap())
            .expect("init ccpanes");
        dir
    }

    #[test]
    fn get_index_on_empty_project_defaults_to_journal_0() {
        let dir = TempDir::new().expect("temp dir");
        let svc = JournalService::default();
        let index = svc
            .get_index(dir.path().to_str().unwrap())
            .expect("index ok");
        assert_eq!(index.active_file, "journal-0.md");
        assert_eq!(index.total_sessions, 0);
    }

    #[test]
    fn get_recent_journal_returns_empty_when_no_file() {
        let dir = TempDir::new().expect("temp dir");
        let svc = JournalService::default();
        let content = svc
            .get_recent_journal(dir.path().to_str().unwrap())
            .expect("ok");
        assert_eq!(content, "");
    }

    #[test]
    fn add_session_fails_without_index() {
        // journal 目录会被创建，但 index.md 不存在时 update_index 必须显式报错
        let dir = TempDir::new().expect("temp dir");
        let svc = JournalService::default();
        let err = svc
            .add_session(dir.path().to_str().unwrap(), summary("t", vec![]))
            .expect_err("no index.md");
        assert_eq!(err, "index.md does not exist");
    }

    #[test]
    fn add_session_appends_content_and_updates_index() {
        let dir = init_project();
        let project = dir.path().to_str().unwrap().to_string();
        let svc = JournalService::default();

        let n = svc
            .add_session(&project, summary("First task", vec!["abc1234".to_string()]))
            .expect("add ok");
        assert_eq!(n, 1);

        let journal = svc.get_recent_journal(&project).expect("read journal");
        assert!(journal.contains("## Session 1: First task"));
        assert!(journal.contains("| `abc1234` | (see git log) |"));

        let index = svc.get_index(&project).expect("index ok");
        assert_eq!(index.active_file, "journal-0.md");
        assert_eq!(index.total_sessions, 1);

        // index.md 的 session-history 表新增一行，commits 以反引号展示
        let index_md =
            fs::read_to_string(dir.path().join(".ccpanes").join("journal").join("index.md"))
                .expect("read index.md");
        assert!(index_md.contains("**Total Sessions**: 1"));
        assert!(index_md.contains("| 1 |"));
        assert!(index_md.contains("`abc1234`"));
    }

    #[test]
    fn add_session_increments_session_number() {
        let dir = init_project();
        let project = dir.path().to_str().unwrap().to_string();
        let svc = JournalService::default();

        assert_eq!(svc.add_session(&project, summary("a", vec![])).unwrap(), 1);
        assert_eq!(svc.add_session(&project, summary("b", vec![])).unwrap(), 2);

        let journal = svc.get_recent_journal(&project).expect("read journal");
        assert!(journal.contains("## Session 1: a"));
        assert!(journal.contains("## Session 2: b"));
        // 无 commit 的会话标记为 planning session
        assert!(journal.contains("(no commits - planning session)"));
    }

    #[test]
    fn add_session_rotates_journal_file_when_max_lines_exceeded() {
        let dir = init_project();
        let project = dir.path().to_str().unwrap().to_string();
        let journal_dir = dir.path().join(".ccpanes").join("journal");

        // 把 journal-0.md 填到超过 MAX_LINES
        let big = "line\n".repeat(MAX_LINES + 1);
        fs::write(journal_dir.join("journal-0.md"), big).expect("fill journal-0");

        let svc = JournalService::default();
        let n = svc
            .add_session(&project, summary("rotated", vec![]))
            .expect("add ok");
        assert_eq!(n, 1);

        // 新会话写进 journal-1.md，index 指向新文件
        assert!(journal_dir.join("journal-1.md").exists());
        let index = svc.get_index(&project).expect("index ok");
        assert_eq!(index.active_file, "journal-1.md");

        let journal = svc.get_recent_journal(&project).expect("read latest");
        assert!(journal.contains("# Session Journal (Part 1)"));
        assert!(journal.contains("## Session 1: rotated"));
    }

    #[test]
    fn get_latest_journal_picks_highest_numbered_file() {
        let dir = init_project();
        let project = dir.path().to_str().unwrap().to_string();
        let journal_dir = dir.path().join(".ccpanes").join("journal");
        fs::write(journal_dir.join("journal-3.md"), "part 3\n").expect("write journal-3");

        let svc = JournalService::default();
        let index = svc.get_index(&project).expect("index ok");
        assert_eq!(index.active_file, "journal-3.md");
        assert_eq!(svc.get_recent_journal(&project).expect("read"), "part 3\n");
    }

    #[test]
    fn by_workspace_variants_resolve_under_workspaces_dir() {
        let root = TempDir::new().expect("temp dir");
        let ws_dir = root.path().join("my-ws");
        fs::create_dir_all(&ws_dir).expect("create workspace dir");
        ProjectContextService::new()
            .init_ccpanes(ws_dir.to_str().unwrap())
            .expect("init ccpanes");

        let svc = JournalService::new(root.path().to_path_buf());
        let n = svc
            .add_session_by_workspace("my-ws", summary("ws task", vec![]))
            .expect("add ok");
        assert_eq!(n, 1);

        let index = svc.get_index_by_workspace("my-ws").expect("index ok");
        assert_eq!(index.total_sessions, 1);

        let journal = svc
            .get_recent_journal_by_workspace("my-ws")
            .expect("read ok");
        assert!(journal.contains("## Session 1: ws task"));
    }
}
