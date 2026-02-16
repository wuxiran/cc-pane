//! 工作日志模块
//!
//! 记录每次工作进度到 markdown 文件

use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};

/// 日志目录名
const JOURNAL_DIR: &str = ".cc-panes";
/// 单个日志文件最大行数
const MAX_LINES_PER_FILE: usize = 2000;

/// 会话记录
#[derive(Debug, Clone)]
pub struct SessionRecord {
    /// 会话编号
    pub number: u32,
    /// 会话标题
    pub title: String,
    /// 日期
    pub date: String,
    /// 摘要
    pub summary: String,
    /// Git commits
    pub commits: Vec<String>,
    /// 状态
    pub status: RecordStatus,
}

/// 记录状态
#[derive(Debug, Clone)]
pub enum RecordStatus {
    Completed,
    InProgress,
    Abandoned,
}

impl RecordStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecordStatus::Completed => "[OK] **已完成**",
            RecordStatus::InProgress => "[...] **进行中**",
            RecordStatus::Abandoned => "[X] **已放弃**",
        }
    }
}

/// 获取日志目录路径
pub fn journal_dir(workspace_dir: &str) -> PathBuf {
    Path::new(workspace_dir).join(JOURNAL_DIR)
}

/// 获取索引文件路径
pub fn index_path(workspace_dir: &str) -> PathBuf {
    journal_dir(workspace_dir).join("index.md")
}

/// 获取当前活跃的日志文件路径
pub fn active_journal_path(workspace_dir: &str) -> Result<PathBuf> {
    let dir = journal_dir(workspace_dir);

    // 查找现有的日志文件
    let mut max_index = 0;
    if dir.exists() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if let Some(idx) = parse_journal_index(&name_str) {
                max_index = max_index.max(idx);
            }
        }
    }

    let current_path = dir.join(format!("journal-{}.md", max_index));

    // 检查是否需要创建新文件
    if current_path.exists() {
        let content = fs::read_to_string(&current_path)?;
        let line_count = content.lines().count();
        if line_count >= MAX_LINES_PER_FILE {
            return Ok(dir.join(format!("journal-{}.md", max_index + 1)));
        }
    }

    Ok(current_path)
}

/// 解析日志文件索引
fn parse_journal_index(filename: &str) -> Option<u32> {
    if filename.starts_with("journal-") && filename.ends_with(".md") {
        let num_str = &filename[8..filename.len() - 3];
        num_str.parse().ok()
    } else {
        None
    }
}

/// 初始化日志目录
pub fn init_journal(workspace_dir: &str) -> Result<()> {
    let dir = journal_dir(workspace_dir);
    fs::create_dir_all(&dir)?;

    // 创建索引文件（如果不存在）
    let idx_path = index_path(workspace_dir);
    if !idx_path.exists() {
        let content = generate_initial_index();
        fs::write(&idx_path, content)?;
    }

    // 创建初始日志文件（如果不存在）
    let journal_path = dir.join("journal-0.md");
    if !journal_path.exists() {
        let content = generate_initial_journal(0);
        fs::write(&journal_path, content)?;
    }

    Ok(())
}

/// 生成初始索引文件内容
fn generate_initial_index() -> String {
    r#"# CC-Panes 工作日志

## 当前状态
<!-- @@@auto:current-status -->
- **活跃文件**: `journal-0.md`
- **总会话数**: 0
- **最后活跃**: -
<!-- @@@/auto:current-status -->

## 日志文件
<!-- @@@auto:active-documents -->
| 文件 | 行数 | 状态 |
|------|------|------|
| `journal-0.md` | ~0 | Active |
<!-- @@@/auto:active-documents -->

## 会话历史
<!-- @@@auto:session-history -->
| # | 日期 | 标题 | Commits |
|---|------|------|---------|
<!-- @@@/auto:session-history -->
"#
    .to_string()
}

/// 生成初始日志文件内容
fn generate_initial_journal(part: u32) -> String {
    format!("# 工作日志 (Part {})\n\n", part)
}

/// 添加会话记录
pub fn add_session(workspace_dir: &str, record: &SessionRecord) -> Result<()> {
    // 确保日志目录已初始化
    init_journal(workspace_dir)?;

    // 获取活跃日志文件
    let journal_path = active_journal_path(workspace_dir)?;

    // 如果文件不存在，创建它
    if !journal_path.exists() {
        let part = parse_journal_index(&journal_path.file_name().unwrap().to_string_lossy())
            .unwrap_or(0);
        fs::write(&journal_path, generate_initial_journal(part))?;
    }

    // 生成会话记录内容
    let session_content = format_session_record(record);

    // 追加到日志文件
    let mut content = fs::read_to_string(&journal_path)?;
    content.push_str(&session_content);
    fs::write(&journal_path, content)?;

    // 更新索引
    update_index(workspace_dir, record)?;

    Ok(())
}

/// 格式化会话记录
fn format_session_record(record: &SessionRecord) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "\n---\n\n## Session {}: {}\n\n",
        record.number, record.title
    ));
    content.push_str(&format!("**日期**: {}\n\n", record.date));

    if !record.summary.is_empty() {
        content.push_str("### 摘要\n");
        content.push_str(&record.summary);
        content.push_str("\n\n");
    }

    if !record.commits.is_empty() {
        content.push_str("### Git Commits\n");
        content.push_str("| Hash | Message |\n");
        content.push_str("|------|---------|");
        for commit in &record.commits {
            content.push_str(&format!("\n| `{}` | - |", commit));
        }
        content.push_str("\n\n");
    }

    content.push_str("### 状态\n");
    content.push_str(record.status.as_str());
    content.push_str("\n");

    content
}

/// 更新索引文件
pub fn update_index(workspace_dir: &str, record: &SessionRecord) -> Result<()> {
    let idx_path = index_path(workspace_dir);
    let content = fs::read_to_string(&idx_path)?;

    // 更新各个自动区块
    let content = update_auto_section(
        &content,
        "current-status",
        &format_current_status(workspace_dir, record)?,
    );

    let content = update_auto_section(
        &content,
        "active-documents",
        &format_active_documents(workspace_dir)?,
    );

    let content = update_auto_section(
        &content,
        "session-history",
        &format_session_history(&content, record),
    );

    fs::write(&idx_path, content)?;
    Ok(())
}

/// 更新自动区块内容
fn update_auto_section(content: &str, section: &str, new_content: &str) -> String {
    let start_marker = format!("<!-- @@@auto:{} -->", section);
    let end_marker = format!("<!-- @@@/auto:{} -->", section);

    if let (Some(start), Some(end)) = (content.find(&start_marker), content.find(&end_marker)) {
        let before = &content[..start + start_marker.len()];
        let after = &content[end..];
        format!("{}\n{}\n{}", before, new_content, after)
    } else {
        content.to_string()
    }
}

/// 格式化当前状态区块
fn format_current_status(workspace_dir: &str, record: &SessionRecord) -> Result<String> {
    let active_journal = active_journal_path(workspace_dir)?;
    let filename = active_journal
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "journal-0.md".to_string());

    Ok(format!(
        "- **活跃文件**: `{}`\n- **总会话数**: {}\n- **最后活跃**: {}",
        filename, record.number, record.date
    ))
}

/// 格式化活跃文档区块
fn format_active_documents(workspace_dir: &str) -> Result<String> {
    let dir = journal_dir(workspace_dir);
    let mut docs = Vec::new();

    if dir.exists() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if parse_journal_index(&name_str).is_some() {
                let path = entry.path();
                let lines = fs::read_to_string(&path)
                    .map(|c| c.lines().count())
                    .unwrap_or(0);
                let status = if lines >= MAX_LINES_PER_FILE {
                    "Archived"
                } else {
                    "Active"
                };
                docs.push((name_str, lines, status));
            }
        }
    }

    docs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut result = String::from("| 文件 | 行数 | 状态 |\n|------|------|------|");
    for (name, lines, status) in docs {
        result.push_str(&format!("\n| `{}` | ~{} | {} |", name, lines, status));
    }

    Ok(result)
}

/// 格式化会话历史区块
fn format_session_history(content: &str, record: &SessionRecord) -> String {
    let start_marker = "<!-- @@@auto:session-history -->";
    let end_marker = "<!-- @@@/auto:session-history -->";

    // 提取现有历史
    let existing = if let (Some(start), Some(end)) =
        (content.find(start_marker), content.find(end_marker))
    {
        let section_start = start + start_marker.len();
        content[section_start..end].trim().to_string()
    } else {
        String::new()
    };

    // 构建新行
    let commits_str = if record.commits.is_empty() {
        "-".to_string()
    } else {
        format!("`{}`", record.commits.join("`, `"))
    };
    let new_row = format!(
        "| {} | {} | {} | {} |",
        record.number, record.date, record.title, commits_str
    );

    // 合并：始终保留表头，追加新行
    let table_header = "| # | 日期 | 标题 | Commits |\n|---|------|------|---------|";
    if existing.contains("| # |") {
        // 已有表头，直接追加
        format!("{}\n{}", existing, new_row)
    } else {
        // 无表头，生成完整表格
        format!("{}\n{}", table_header, new_row)
    }
}

/// 获取下一个会话编号
pub fn next_session_number(workspace_dir: &str) -> Result<u32> {
    let idx_path = index_path(workspace_dir);
    if !idx_path.exists() {
        return Ok(1);
    }

    let content = fs::read_to_string(&idx_path)?;

    // 从会话历史中提取最大编号
    let mut max_num = 0u32;
    for line in content.lines() {
        if line.starts_with("| ") && !line.starts_with("| #") && !line.starts_with("|---") {
            if let Some(num_str) = line.split('|').nth(1) {
                if let Ok(num) = num_str.trim().parse::<u32>() {
                    max_num = max_num.max(num);
                }
            }
        }
    }

    Ok(max_num + 1)
}

