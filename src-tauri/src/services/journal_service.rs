use std::fs;
use std::path::PathBuf;
use chrono::Local;
use serde::{Deserialize, Serialize};

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
        self.workspaces_dir.join(workspace_name).to_string_lossy().to_string()
    }

    /// 添加会话摘要（按 workspace 名称）
    pub fn add_session_by_workspace(&self, workspace_name: &str, summary: SessionSummary) -> Result<u32, String> {
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
                    if let Some(num_str) = name.strip_prefix("journal-").and_then(|s| s.strip_suffix(".md")) {
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

        format!(r#"
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
"#, session_num, summary.title, summary.date, summary.title, summary.summary, commits_table)
    }

    /// 创建新的 journal 文件
    fn create_new_journal_file(&self, project_path: &str, num: u32) -> Result<PathBuf, String> {
        let journal_dir = Self::get_journal_dir(project_path);
        let new_file = journal_dir.join(format!("journal-{}.md", num));
        let today = Local::now().format("%Y-%m-%d").to_string();

        let content = format!(r#"# Session Journal (Part {})

> Continuation from `journal-{}.md` (archived at ~{} lines)
> Started: {}
> Managed by CC-Panes

---
"#, num, num - 1, MAX_LINES, today);

        fs::write(&new_file, content)
            .map_err(|e| format!("Failed to create journal file: {}", e))?;

        Ok(new_file)
    }

    /// 更新索引文件
    fn update_index(&self, project_path: &str, session_num: u32, title: &str, commits: &[String], active_file: &str) -> Result<(), String> {
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
            commits.iter()
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
                    new_content.push_str(&format!("| {} | {} | {} | {} |\n",
                        session_num, today, title, commits_display));
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
        let (current_file, current_num, current_lines) = self.get_latest_journal_info(project_path)?;
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
        self.update_index(project_path, new_session, &summary.title, &summary.commits, &active_file)?;

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

        fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read journal: {}", e))
    }
}

impl Default for JournalService {
    fn default() -> Self {
        Self::new(PathBuf::new())
    }
}