use crate::models::spec::*;
use crate::models::todo::*;
use crate::repository::spec_repo::SpecRepository;
use crate::services::TodoService;
use crate::utils::error::{AppError, AppResult};
use crate::utils::error_codes as EC;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, error, info, warn};

/// Spec 业务逻辑层
pub struct SpecService {
    spec_repo: Arc<SpecRepository>,
    todo_service: Arc<TodoService>,
    /// 项目级锁：同一项目的 sync/append 操作串行化
    project_locks: std::sync::Mutex<HashMap<String, Arc<TokioMutex<()>>>>,
}

impl SpecService {
    pub fn new(spec_repo: Arc<SpecRepository>, todo_service: Arc<TodoService>) -> Self {
        Self {
            spec_repo,
            todo_service,
            project_locks: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 获取项目级锁
    fn get_project_lock(&self, project_path: &str) -> AppResult<Arc<TokioMutex<()>>> {
        let mut locks = self
            .project_locks
            .lock()
            .map_err(|_| AppError::from("Project lock poisoned"))?;
        Ok(locks
            .entry(project_path.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone())
    }

    // ============ CRUD ============

    /// 创建 Spec（事务补偿：DB → 文件 → Todo → 更新 todo_id）
    pub fn create_spec(&self, req: CreateSpecRequest) -> AppResult<SpecEntry> {
        debug!("svc::create_spec");
        let title = req.title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::coded(
                EC::SPEC_TITLE_EMPTY,
                "Spec title cannot be empty",
            ));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let spec_id = uuid::Uuid::new_v4().to_string();
        let file_name = Self::title_to_filename(&title);

        let entry = SpecEntry {
            id: spec_id.clone(),
            project_path: req.project_path.clone(),
            title: title.clone(),
            file_name: file_name.clone(),
            status: SpecStatus::Draft,
            todo_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            archived_at: None,
        };

        // Step 1: DB 插入
        self.spec_repo
            .insert(&entry)
            .map_err(|e| AppError::from(format!("Failed to insert spec: {}", e)))?;

        // Step 2: 创建 Spec 文件
        let spec_dir = Self::spec_dir(&req.project_path);
        if let Err(e) = std::fs::create_dir_all(&spec_dir) {
            // 补偿：删除 DB 记录
            let _ = self.spec_repo.delete(&spec_id);
            return Err(AppError::from(format!(
                "Failed to create spec directory: {}",
                e
            )));
        }

        let spec_path = spec_dir.join(&file_name);
        let initial_content = Self::render_template(&title, &now);
        if let Err(e) = std::fs::write(&spec_path, &initial_content) {
            // 补偿：删除 DB 记录
            let _ = self.spec_repo.delete(&spec_id);
            return Err(AppError::from(format!("Failed to write spec file: {}", e)));
        }

        // Step 3: 创建关联 Todo（todoType="spec"）
        let todo_result = self.todo_service.create_todo(CreateTodoRequest {
            title: title.clone(),
            description: Some(format!("Spec: {}", spec_id)),
            scope: Some(TodoScope::Project),
            scope_ref: Some(req.project_path.clone()),
            todo_type: Some("spec".to_string()),
            ..Default::default()
        });

        match todo_result {
            Ok(todo) => {
                // Step 4: 更新 DB 关联 todo_id
                if let Err(e) =
                    self.spec_repo
                        .update(&spec_id, None, None, None, Some(&todo.id), None)
                {
                    warn!("Failed to update spec todo_id: {}", e);
                }

                // 创建子任务（如果有初始任务列表）
                if let Some(tasks) = req.tasks {
                    for task_title in tasks {
                        if let Err(e) = self.todo_service.add_subtask(&todo.id, &task_title) {
                            warn!("Failed to add subtask '{}': {}", task_title, e);
                        }
                    }
                }

                // 同步 Tasks 段到文件
                let _ = self.sync_tasks_inner(&req.project_path, &spec_id);

                let mut result = entry;
                result.todo_id = Some(todo.id);
                Ok(result)
            }
            Err(e) => {
                // 补偿：删除文件 + DB 记录
                let _ = std::fs::remove_file(&spec_path);
                let _ = self.spec_repo.delete(&spec_id);
                Err(AppError::from(format!("Failed to create spec todo: {}", e)))
            }
        }
    }

    /// 列出项目的 Spec
    pub fn list_specs(
        &self,
        project_path: &str,
        status: Option<SpecStatus>,
    ) -> AppResult<Vec<SpecEntry>> {
        self.spec_repo
            .list_by_project(project_path, status.as_ref())
            .map_err(AppError::from)
    }

    /// 获取 Spec 文件内容
    pub fn get_spec_content(&self, project_path: &str, spec_id: &str) -> AppResult<String> {
        let entry = self.get_spec_entry(spec_id)?;
        let path = self.resolve_spec_path(project_path, &entry);
        std::fs::read_to_string(&path)
            .map_err(|e| AppError::from(format!("Failed to read spec file: {}", e)))
    }

    /// 保存 Spec 文件内容
    pub fn save_spec_content(
        &self,
        project_path: &str,
        spec_id: &str,
        content: &str,
    ) -> AppResult<()> {
        let entry = self.get_spec_entry(spec_id)?;
        let path = self.resolve_spec_path(project_path, &entry);
        std::fs::write(&path, content)
            .map_err(|e| AppError::from(format!("Failed to write spec file: {}", e)))?;
        // 更新 updated_at
        let _ = self.spec_repo.update(spec_id, None, None, None, None, None);
        Ok(())
    }

    /// 更新 Spec 元数据（标题、状态）
    pub fn update_spec(&self, spec_id: &str, req: UpdateSpecRequest) -> AppResult<SpecEntry> {
        debug!("svc::update_spec");
        let entry = self.get_spec_entry(spec_id)?;

        // 状态转换逻辑
        if let Some(ref new_status) = req.status {
            match new_status {
                SpecStatus::Active => {
                    // 激活时先取消其他 active
                    self.spec_repo
                        .deactivate_all(&entry.project_path)
                        .map_err(AppError::from)?;
                }
                SpecStatus::Archived => {
                    // 归档时移动文件
                    self.archive_spec_file(&entry)?;
                }
                SpecStatus::Draft => {
                    // Draft 允许从 Active 回退
                }
            }
        }

        let archived_at = if req.status.as_ref() == Some(&SpecStatus::Archived) {
            Some(chrono::Utc::now().to_rfc3339())
        } else {
            None
        };

        self.spec_repo
            .update(
                spec_id,
                req.title.as_deref(),
                None,
                req.status.as_ref(),
                None,
                archived_at.as_deref(),
            )
            .map_err(AppError::from)?;

        self.get_spec_entry(spec_id)
    }

    /// 删除 Spec（级联清理：Todo 子任务 → Todo → 文件 → DB）
    pub fn delete_spec(&self, project_path: &str, spec_id: &str) -> AppResult<()> {
        debug!("svc::delete_spec");
        let entry = self.spec_repo.get(spec_id).map_err(AppError::from)?;

        if let Some(entry) = &entry {
            // 1. 删除关联 Todo（级联删除子任务）
            if let Some(ref todo_id) = entry.todo_id {
                if let Err(e) = self.todo_service.delete_todo(todo_id) {
                    error!("Failed to delete spec todo {}: {}", todo_id, e);
                }
            }

            // 2. 删除 Spec 文件
            let path = self.resolve_spec_path(project_path, entry);
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    error!("Failed to delete spec file {:?}: {}", path, e);
                }
            }
        }

        // 3. 删除 DB 记录
        self.spec_repo.delete(spec_id).map_err(AppError::from)?;
        Ok(())
    }

    // ============ 同步逻辑 ============

    /// 同步 Tasks 段（持锁操作）
    pub fn sync_tasks(&self, project_path: &str, spec_id: &str) -> AppResult<()> {
        let lock = self.get_project_lock(project_path)?;
        // 使用 blocking 方式获取 tokio mutex（因为我们在同步上下文中）
        let _guard = lock.blocking_lock();
        self.sync_tasks_inner(project_path, spec_id)
    }

    /// 同步内部实现（不加锁，由调用者负责）
    fn sync_tasks_inner(&self, project_path: &str, spec_id: &str) -> AppResult<()> {
        let entry = self.get_spec_entry(spec_id)?;
        let spec_path = self.resolve_spec_path(project_path, &entry);

        // 读取 Spec 文件
        let content = match std::fs::read_to_string(&spec_path) {
            Ok(c) => c,
            Err(e) => {
                warn!("sync_tasks: cannot read spec file: {}", e);
                return Ok(());
            }
        };

        // 获取 Todo 子任务列表
        let todo_id = match &entry.todo_id {
            Some(id) => id.clone(),
            None => return Ok(()),
        };

        let todo = match self.todo_service.get_todo(&todo_id)? {
            Some(t) => t,
            None => return Ok(()),
        };

        // 解析 Spec 文件中的 checkbox（回收 AI 的 checkbox 改动）
        let spec_checkboxes = Self::parse_tasks_section(&content);
        for (checked, task_title) in &spec_checkboxes {
            if *checked {
                // AI 在 Spec 中打勾 → 回收到 Todo 子任务
                let clean_title = Self::strip_priority_suffix(task_title);
                for subtask in &todo.subtasks {
                    let subtask_clean = Self::strip_priority_suffix(&subtask.title);
                    if subtask_clean == clean_title && !subtask.completed {
                        let _ = self
                            .todo_service
                            .update_subtask(&subtask.id, None, Some(true));
                    }
                }
            }
        }

        // 重新获取最新 Todo 状态
        let todo = match self.todo_service.get_todo(&todo_id)? {
            Some(t) => t,
            None => return Ok(()),
        };

        // 渲染最新的 Tasks 段
        let tasks_md = Self::render_tasks_section(&todo.subtasks);

        // 替换文件中的 Tasks 段
        let new_content = Self::replace_tasks_section(&content, &tasks_md);
        std::fs::write(&spec_path, &new_content)
            .map_err(|e| AppError::from(format!("Failed to write spec: {}", e)))?;

        Ok(())
    }

    /// 获取 active spec 的摘要（终端注入用，失败返回 None）
    pub fn get_active_spec_summary(&self, project_path: &str) -> AppResult<Option<SpecSummary>> {
        let entry = match self
            .spec_repo
            .get_active(project_path)
            .map_err(AppError::from)?
        {
            Some(e) => e,
            None => return Ok(None),
        };

        let spec_path = self.resolve_spec_path(project_path, &entry);
        let spec_path_str = spec_path.to_string_lossy().to_string();

        // 读取文件获取任务摘要
        let tasks_summary = match std::fs::read_to_string(&spec_path) {
            Ok(content) => {
                let checkboxes = Self::parse_tasks_section(&content);
                let done = checkboxes.iter().filter(|(c, _)| *c).count();
                let total = checkboxes.len();
                format!("{}/{} tasks completed", done, total)
            }
            Err(_) => "unable to read spec".to_string(),
        };

        Ok(Some(SpecSummary {
            spec_id: entry.id,
            title: entry.title,
            file_path: spec_path_str,
            tasks_summary,
        }))
    }

    /// 追加 Log 段（持锁操作）
    pub fn append_log(&self, project_path: &str, spec_id: &str, log_entry: &str) -> AppResult<()> {
        if log_entry.trim().is_empty() {
            return Ok(());
        }

        let lock = self.get_project_lock(project_path)?;
        let _guard = lock.blocking_lock();

        let entry = self.get_spec_entry(spec_id)?;
        let spec_path = self.resolve_spec_path(project_path, &entry);

        let content = std::fs::read_to_string(&spec_path)
            .map_err(|e| AppError::from(format!("Failed to read spec for log: {}", e)))?;

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let new_content = Self::append_to_log_section(&content, &today, log_entry);

        std::fs::write(&spec_path, &new_content)
            .map_err(|e| AppError::from(format!("Failed to write spec log: {}", e)))?;

        Ok(())
    }

    // ============ 辅助方法 ============

    fn get_spec_entry(&self, spec_id: &str) -> AppResult<SpecEntry> {
        self.spec_repo
            .get(spec_id)
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::coded_with_params(
                    EC::SPEC_NOT_FOUND,
                    format!("Spec {} not found", spec_id),
                    HashMap::from([("id".into(), spec_id.into())]),
                )
            })
    }

    fn resolve_spec_path(&self, project_path: &str, entry: &SpecEntry) -> PathBuf {
        if entry.status == SpecStatus::Archived {
            Self::spec_dir(project_path)
                .join("archived")
                .join(&entry.file_name)
        } else {
            Self::spec_dir(project_path).join(&entry.file_name)
        }
    }

    fn spec_dir(project_path: &str) -> PathBuf {
        Path::new(project_path).join(".ccpanes").join("specs")
    }

    fn title_to_filename(title: &str) -> String {
        let slug: String = title
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        // 去除连续的 - 和首尾的 -
        let slug = slug
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        format!("{}.spec.md", slug)
    }

    fn render_template(title: &str, created_at: &str) -> String {
        // 提取日期部分
        let date = if created_at.len() >= 10 {
            &created_at[..10]
        } else {
            created_at
        };

        format!(
            r#"# Spec: {title}
> Status: draft | Created: {date}

## Proposal
变更动机和目标。

## Design
技术方案。

### Affected Files
- `src/xxx.ts` [ADDED]
- `src/yyy.ts` [MODIFIED]

## Tasks (auto-synced from CC-Panes)
<!-- 此段由 CC-Panes 自动同步，请在 Todo 面板中编辑 -->

## Log
"#,
            title = title,
            date = date,
        )
    }

    /// 解析 Tasks 段中的 checkbox
    /// 返回 Vec<(checked, title)>
    fn parse_tasks_section(content: &str) -> Vec<(bool, String)> {
        let mut results = Vec::new();

        // 找到 Tasks 段
        let tasks_content = match Self::extract_tasks_section(content) {
            Some(c) => c,
            None => return results,
        };

        // 剥离代码块
        let stripped = Self::strip_code_fences(&tasks_content);

        // 解析第一层列表 checkbox
        for line in stripped.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("- [x] ") {
                results.push((true, rest.to_string()));
            } else if let Some(rest) = trimmed.strip_prefix("- [X] ") {
                results.push((true, rest.to_string()));
            } else if let Some(rest) = trimmed.strip_prefix("- [ ] ") {
                results.push((false, rest.to_string()));
            }
        }

        results
    }

    /// 提取 ## Tasks 到下一个 ## 之间的内容
    fn extract_tasks_section(content: &str) -> Option<String> {
        let lines: Vec<&str> = content.lines().collect();
        let mut start = None;
        let mut end = lines.len();

        for (i, line) in lines.iter().enumerate() {
            if start.is_none() {
                if line.starts_with("## Tasks") {
                    start = Some(i + 1);
                }
            } else if line.starts_with("## ") {
                end = i;
                break;
            }
        }

        start.map(|s| lines[s..end].join("\n"))
    }

    /// 剥离 ```...``` 代码块
    fn strip_code_fences(text: &str) -> String {
        let mut result = String::new();
        let mut in_fence = false;

        for line in text.lines() {
            if line.trim_start().starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if !in_fence {
                result.push_str(line);
                result.push('\n');
            }
        }

        result
    }

    /// 渲染 Todo 子任务为 Markdown checkbox
    fn render_tasks_section(subtasks: &[TodoSubtask]) -> String {
        if subtasks.is_empty() {
            return String::new();
        }
        subtasks
            .iter()
            .map(|s| {
                let mark = if s.completed { "x" } else { " " };
                format!("- [{}] {}", mark, s.title)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 替换 Tasks 段内容（保留段前后不变）
    fn replace_tasks_section(content: &str, new_tasks: &str) -> String {
        let lines: Vec<&str> = content.lines().collect();
        let mut result = Vec::new();
        let mut start = None;
        let mut end = lines.len();

        for (i, line) in lines.iter().enumerate() {
            if start.is_none() {
                if line.starts_with("## Tasks") {
                    start = Some(i);
                }
            } else if line.starts_with("## ") {
                end = i;
                break;
            }
        }

        match start {
            Some(s) => {
                // 保留 Tasks 标题行
                for line in &lines[..=s] {
                    result.push(*line);
                }
                // 保留注释行（如果有）
                let comment_line = "<!-- 此段由 CC-Panes 自动同步，请在 Todo 面板中编辑 -->";
                result.push(comment_line);
                // 添加新的 tasks 内容
                if !new_tasks.is_empty() {
                    result.push(new_tasks);
                }
                result.push(""); // 空行分隔
                                 // 保留后续内容
                for line in &lines[end..] {
                    result.push(*line);
                }
            }
            None => {
                // 没有 Tasks 段，直接返回原内容
                return content.to_string();
            }
        }

        result.join("\n")
    }

    /// 追加到 Log 段
    fn append_to_log_section(content: &str, date: &str, log_entry: &str) -> String {
        let lines: Vec<&str> = content.lines().collect();
        let mut result = Vec::new();
        let mut log_start = None;

        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("## Log") {
                log_start = Some(i);
            }
        }

        match log_start {
            Some(idx) => {
                // 复制到 Log 段结束
                for line in &lines {
                    result.push(line.to_string());
                }
                // 检查是否已有当天的日期标题
                let date_header = format!("### {}", date);
                let has_today = lines[idx..].iter().any(|l| l.trim() == date_header.trim());

                if has_today {
                    // 找到当天最后一条 "- " 条目的位置，在其后插入新条目
                    let mut insert_after = 0;
                    let mut found_today = false;

                    for (i, line) in result.iter().enumerate() {
                        if !found_today && i > idx && line.trim() == date_header.trim() {
                            found_today = true;
                            insert_after = i; // 至少在日期标题后
                        } else if found_today {
                            let trimmed = line.trim();
                            if trimmed.starts_with("- ") {
                                insert_after = i; // 扩展到最后一条条目
                            } else if trimmed.starts_with("### ") {
                                break; // 遇到下一个日期段
                            }
                        }
                    }

                    let mut new_result = Vec::new();
                    for (i, line) in result.iter().enumerate() {
                        new_result.push(line.clone());
                        if i == insert_after {
                            new_result.push(format!("- {}", log_entry));
                        }
                    }

                    return new_result.join("\n");
                } else {
                    // 添加新日期标题
                    result.push(date_header);
                    result.push(format!("- {}", log_entry));
                }
            }
            None => {
                // 没有 Log 段，追加一个
                for line in &lines {
                    result.push(line.to_string());
                }
                result.push("## Log".to_string());
                result.push(format!("### {}", date));
                result.push(format!("- {}", log_entry));
            }
        }

        result.join("\n")
    }

    /// 归档 spec 文件（移动到 archived/ 子目录）
    fn archive_spec_file(&self, entry: &SpecEntry) -> AppResult<()> {
        let spec_dir = Self::spec_dir(&entry.project_path);
        let archived_dir = spec_dir.join("archived");
        std::fs::create_dir_all(&archived_dir)
            .map_err(|e| AppError::from(format!("Failed to create archived dir: {}", e)))?;

        let src = spec_dir.join(&entry.file_name);
        if src.exists() {
            // 添加日期前缀避免冲突
            let date_prefix = chrono::Local::now().format("%Y%m%d").to_string();
            let archived_name = format!("{}_{}", date_prefix, entry.file_name);
            let dst = archived_dir.join(&archived_name);
            std::fs::rename(&src, &dst)
                .map_err(|e| AppError::from(format!("Failed to archive spec file: {}", e)))?;

            // 更新 DB 的 file_name 为归档后的文件名
            let _ = self
                .spec_repo
                .update(&entry.id, None, Some(&archived_name), None, None, None);
            info!("Spec file archived: {:?} → {:?}", src, dst);
        }
        Ok(())
    }

    /// 去掉标题中的优先级后缀 "(高优先级)" 等
    fn strip_priority_suffix(title: &str) -> String {
        let title = title.trim();
        // 匹配 " (xxx优先级)" 或 " (high/medium/low)"
        if let Some(idx) = title.rfind(" (") {
            let suffix = &title[idx..];
            if suffix.ends_with(')') {
                let inner = &suffix[2..suffix.len() - 1];
                if inner.contains("优先级")
                    || inner == "high"
                    || inner == "medium"
                    || inner == "low"
                {
                    return title[..idx].to_string();
                }
            }
        }
        title.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_title_to_filename() {
        assert_eq!(
            SpecService::title_to_filename("Add Dark Mode"),
            "add-dark-mode.spec.md"
        );
        assert_eq!(
            SpecService::title_to_filename("  Fix  Bug  "),
            "fix-bug.spec.md"
        );
        // 中文标题应保留中文字符
        assert_eq!(
            SpecService::title_to_filename("添加暗黑模式"),
            "添加暗黑模式.spec.md"
        );
        assert_eq!(
            SpecService::title_to_filename("Fix Bug 修复"),
            "fix-bug-修复.spec.md"
        );
    }

    #[test]
    fn test_parse_tasks_section() {
        let content = r#"# Spec: Test
## Tasks (auto-synced from CC-Panes)
<!-- comment -->
- [x] Task 1
- [ ] Task 2
- [X] Task 3

## Log
"#;
        let tasks = SpecService::parse_tasks_section(content);
        assert_eq!(tasks.len(), 3);
        assert!(tasks[0].0);
        assert_eq!(tasks[0].1, "Task 1");
        assert!(!tasks[1].0);
        assert_eq!(tasks[1].1, "Task 2");
        assert!(tasks[2].0);
    }

    #[test]
    fn test_parse_tasks_with_code_fence() {
        let content = r#"## Tasks
```
- [x] This should be ignored
```
- [ ] Real task
"#;
        let tasks = SpecService::parse_tasks_section(content);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].1, "Real task");
    }

    #[test]
    fn test_replace_tasks_section() {
        let content = r#"# Spec
## Tasks (auto-synced from CC-Panes)
<!-- old -->
- [ ] old task

## Log
### 2026-03-15
"#;
        let new_tasks = "- [x] new task 1\n- [ ] new task 2";
        let result = SpecService::replace_tasks_section(content, new_tasks);
        assert!(result.contains("new task 1"));
        assert!(result.contains("new task 2"));
        assert!(result.contains("## Log"));
        assert!(!result.contains("old task"));
    }

    #[test]
    fn test_append_to_log_section() {
        let content = "# Spec\n## Log\n";
        let result =
            SpecService::append_to_log_section(content, "2026-03-15", "ADDED `src/foo.ts`");
        assert!(result.contains("### 2026-03-15"));
        assert!(result.contains("- ADDED `src/foo.ts`"));
    }

    #[test]
    fn test_append_to_log_section_existing_date() {
        // 当天已有条目时，新条目应追加到末尾而非日期标题后
        let content = "# Spec\n## Log\n### 2026-03-15\n- old entry 1\n- old entry 2\n";
        let result = SpecService::append_to_log_section(content, "2026-03-15", "NEW entry");
        let lines: Vec<&str> = result.lines().collect();
        // 找到所有条目的位置
        let old1_pos = lines
            .iter()
            .position(|l| l.contains("old entry 1"))
            .unwrap();
        let old2_pos = lines
            .iter()
            .position(|l| l.contains("old entry 2"))
            .unwrap();
        let new_pos = lines.iter().position(|l| l.contains("NEW entry")).unwrap();
        // 新条目应在所有旧条目之后
        assert!(new_pos > old1_pos, "NEW should be after old entry 1");
        assert!(new_pos > old2_pos, "NEW should be after old entry 2");
    }

    #[test]
    fn test_strip_priority_suffix() {
        assert_eq!(
            SpecService::strip_priority_suffix("定义 CSS 变量 (高优先级)"),
            "定义 CSS 变量"
        );
        assert_eq!(
            SpecService::strip_priority_suffix("Some task (medium)"),
            "Some task"
        );
        assert_eq!(
            SpecService::strip_priority_suffix("Normal task"),
            "Normal task"
        );
    }

    #[test]
    fn test_render_tasks_section() {
        let subtasks = vec![
            TodoSubtask {
                id: "1".to_string(),
                todo_id: "t1".to_string(),
                title: "Task A".to_string(),
                completed: true,
                sort_order: 0,
                created_at: "".to_string(),
            },
            TodoSubtask {
                id: "2".to_string(),
                todo_id: "t1".to_string(),
                title: "Task B".to_string(),
                completed: false,
                sort_order: 1,
                created_at: "".to_string(),
            },
        ];
        let md = SpecService::render_tasks_section(&subtasks);
        assert_eq!(md, "- [x] Task A\n- [ ] Task B");
    }
}
