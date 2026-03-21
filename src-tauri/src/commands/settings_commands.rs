use crate::models::settings::AppSettings;
use crate::models::Workspace;
use crate::services::SettingsService;
use crate::utils::AppPaths;
use crate::utils::AppResult;
use serde::Serialize;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tracing::{debug, info};

/// 获取设置
#[tauri::command]
pub fn get_settings(service: State<'_, Arc<SettingsService>>) -> AppResult<AppSettings> {
    Ok(service.get_settings())
}

/// 更新设置
#[tauri::command]
pub fn update_settings(
    service: State<'_, Arc<SettingsService>>,
    settings: AppSettings,
) -> AppResult<()> {
    debug!("cmd::update_settings");
    Ok(service.update_settings(settings)?)
}

/// 测试代理连接
#[tauri::command]
pub fn test_proxy(service: State<'_, Arc<SettingsService>>) -> AppResult<bool> {
    let settings = service.get_settings();
    let proxy = &settings.proxy;
    if !proxy.enabled || proxy.host.is_empty() {
        return Err("Proxy is not enabled or not configured".into());
    }

    let addr = format!("{}:{}", proxy.host, proxy.port);
    let socket_addr: std::net::SocketAddr = addr
        .parse()
        .map_err(|e| format!("Failed to parse address: {}", e))?;

    TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map(|_| true)
        .map_err(|e| format!("Failed to connect to proxy {}: {}", addr, e).into())
}

/// 数据目录信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub current_path: String,
    pub default_path: String,
    pub is_default: bool,
    pub size_bytes: u64,
}

/// 获取数据目录信息
#[tauri::command]
pub fn get_data_dir_info(app_paths: State<'_, Arc<AppPaths>>) -> AppResult<DataDirInfo> {
    Ok(DataDirInfo {
        current_path: app_paths.data_dir().to_string_lossy().to_string(),
        default_path: app_paths.default_data_dir().to_string_lossy().to_string(),
        is_default: app_paths.is_default(),
        size_bytes: app_paths.data_dir_size(),
    })
}

/// 迁移数据目录
///
/// 1. 验证目标路径可写
/// 2. 复制 data.db, providers.json, workspaces/
/// 3. 校验文件大小一致
/// 4. 更新 config.toml 中的 data_dir
/// 5. 不删除旧数据
#[tauri::command]
pub fn migrate_data_dir(
    app_paths: State<'_, Arc<AppPaths>>,
    settings_service: State<'_, Arc<SettingsService>>,
    target_dir: String,
) -> AppResult<()> {
    info!(target_dir = %target_dir, "cmd::migrate_data_dir");
    let target = Path::new(&target_dir);
    let source = app_paths.data_dir();

    // 路径安全校验：禁止迁移到系统目录
    let forbidden_prefixes: &[&str] = if cfg!(windows) {
        &[
            "C:\\Windows",
            "C:\\Program Files",
            "C:\\Program Files (x86)",
            "C:\\System32",
        ]
    } else {
        &[
            "/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev",
        ]
    };
    let target_str = target.to_string_lossy();
    for prefix in forbidden_prefixes {
        if target_str.starts_with(prefix) {
            return Err(format!("Migration to system directory is not allowed: {}", prefix).into());
        }
    }

    // 如果目标目录已存在，必须为空目录
    if target.exists() && target.is_dir() {
        let is_empty = std::fs::read_dir(target)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            // 允许与源目录相同（后续逻辑会拦截）
            let target_canonical =
                std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
            let source_canonical =
                std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
            if target_canonical != source_canonical {
                return Err("Target directory must be empty".into());
            }
        }
    }

    // 不能迁移到相同目录（使用 canonicalize 规范化路径，解决 Windows 大小写问题）
    let target_canonical = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let source_canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    if target_canonical == source_canonical {
        return Err("Target directory is the same as current data directory".into());
    }

    // 创建目标目录
    std::fs::create_dir_all(target)
        .map_err(|e| format!("Failed to create target directory: {}", e))?;

    // 验证可写
    let test_file = target.join(".write_test");
    std::fs::write(&test_file, "test")
        .map_err(|e| format!("Target directory is not writable: {}", e))?;
    let _ = std::fs::remove_file(&test_file);

    // 复制 data.db
    copy_if_exists(&source.join("data.db"), &target.join("data.db"))?;

    // 复制 providers.json
    copy_if_exists(
        &source.join("providers.json"),
        &target.join("providers.json"),
    )?;

    // 递归复制 workspaces/
    let src_ws = source.join("workspaces");
    let dst_ws = target.join("workspaces");
    if src_ws.exists() {
        copy_dir_recursive(&src_ws, &dst_ws)?;
    }

    // 校验文件完整性（文件大小一致）
    verify_copy(&source.join("data.db"), &target.join("data.db"))?;
    verify_copy(
        &source.join("providers.json"),
        &target.join("providers.json"),
    )?;

    // 校验 workspaces 目录的文件数量一致
    if src_ws.exists() {
        let src_count = count_files(&src_ws);
        let dst_count = count_files(&dst_ws);
        if src_count != dst_count {
            return Err(format!(
                "Workspaces directory file count mismatch (source: {}, target: {})",
                src_count, dst_count
            )
            .into());
        }
    }

    // 更新设置中的 data_dir
    // 如果目标路径是默认路径，则设为 None（恢复默认）
    let default_path = app_paths.default_data_dir();
    let target_is_default = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf())
        == std::fs::canonicalize(default_path).unwrap_or_else(|_| default_path.to_path_buf());

    let mut current_settings = settings_service.get_settings();
    current_settings.general.data_dir = if target_is_default {
        None
    } else {
        Some(target_dir)
    };
    settings_service
        .update_settings(current_settings)
        .map_err(|e| format!("Failed to update config: {}", e))?;

    Ok(())
}

/// 复制文件（如果源文件存在）
fn copy_if_exists(src: &Path, dst: &Path) -> AppResult<()> {
    if src.exists() {
        let name = crate::utils::sanitize_path_display(src);
        std::fs::copy(src, dst).map_err(|e| format!("Failed to copy {}: {}", name, e))?;
    }
    Ok(())
}

/// 递归复制目录（跳过符号链接）
fn copy_dir_recursive(src: &Path, dst: &Path) -> AppResult<()> {
    let dst_name = crate::utils::sanitize_path_display(dst);
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {}: {}", dst_name, e))?;

    let src_name = crate::utils::sanitize_path_display(src);
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src_name, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_name = entry.file_name().to_string_lossy().to_string();

        // 使用 symlink_metadata 检查，跳过符号链接
        let meta = std::fs::symlink_metadata(&src_path)
            .map_err(|e| format!("Failed to read metadata {}: {}", file_name, e))?;
        if meta.is_symlink() {
            continue;
        }

        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if meta.is_file() {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {}: {}", file_name, e))?;
        }
    }

    Ok(())
}

/// 递归统计目录中的文件数量
fn count_files(path: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                count += 1;
            } else if p.is_dir() {
                count += count_files(&p);
            }
        }
    }
    count
}

/// 工作空间摘要信息
struct WorkspaceSummary {
    name: String,
    project_count: usize,
    path: Option<String>,
}

/// 扫描 workspaces 目录，读取每个 workspace.json 返回摘要
fn collect_workspace_summaries(workspaces_dir: &Path) -> Vec<WorkspaceSummary> {
    let entries = match std::fs::read_dir(workspaces_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut summaries = Vec::new();
    for entry in entries.flatten() {
        let ws_json_path = entry.path().join("workspace.json");
        if !ws_json_path.is_file() {
            continue;
        }
        let content = match std::fs::read_to_string(&ws_json_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let ws: Workspace = match serde_json::from_str(&content) {
            Ok(w) => w,
            Err(_) => continue,
        };
        summaries.push(WorkspaceSummary {
            name: ws.name,
            project_count: ws.projects.len(),
            path: ws.path,
        });
    }
    summaries
}

/// 在数据目录下生成 CLAUDE.md，供 Claude Code 自我对话时参考
#[tauri::command]
pub fn generate_claude_md(app_paths: State<'_, Arc<AppPaths>>) -> AppResult<()> {
    debug!("cmd::generate_claude_md");
    let data_dir = app_paths.data_dir();
    let claude_md_path = data_dir.join("CLAUDE.md");
    let data_dir_display = data_dir.to_string_lossy();

    // 动态：收集工作空间摘要
    let summaries = collect_workspace_summaries(&app_paths.workspaces_dir());
    let workspaces_section = if summaries.is_empty() {
        "暂无工作空间。可通过 CC-Panes 界面创建。\n".to_string()
    } else {
        let mut table =
            String::from("| 工作空间 | 项目数 | 绑定路径 |\n|---------|--------|--------|\n");
        for s in &summaries {
            let path_display = s.path.as_deref().unwrap_or("未绑定");
            table.push_str(&format!(
                "| {} | {} | {} |\n",
                s.name, s.project_count, path_display
            ));
        }
        table
    };

    let content = format!(
        r#"# CC-Panes 数据目录

> 此文件由 CC-Panes 自动生成，供 Claude Code 自我对话时参考。
> 数据目录：`{data_dir}`

## 你能做什么

1. **管理 Todo** — 增删改查、按作用域（global/workspace/project）筛选、子任务管理
2. **查看项目** — 列出所有注册项目、搜索项目、查看别名
3. **查看启动历史** — 最近启动记录、频率统计、按工作空间筛选
4. **管理工作空间** — 列出工作空间、查看配置、查看绑定的项目列表
5. **查看 Provider 配置** — 列出 API Provider（⚠️ 不要在输出中泄露 API Key）
6. **数据分析** — 启动频率、Todo 完成率、项目活跃度等统计查询
7. **数据维护** — 备份数据库、检查数据目录大小

## 目录结构

```
{data_dir}
├── CLAUDE.md            ← 本文件
├── data.db              ← SQLite 数据库（项目、Todo、启动历史）
├── providers.json       ← API Provider 配置
└── workspaces/          ← 工作空间配置目录
    └── <name>/
        ├── workspace.json   ← 工作空间配置
        └── .ccpanes/
            └── journal/     ← 会话日志
```

## 当前工作空间

{workspaces_section}

## 配置文件格式

### workspace.json

```json
{{
  "id": "uuid-string",
  "name": "工作空间名称",
  "alias": "可选别名",
  "createdAt": "2024-01-01T00:00:00Z",
  "projects": [
    {{
      "id": "uuid-string",
      "path": "D:\\projects\\my-project",
      "alias": "可选项目别名"
    }}
  ],
  "providerId": "可选，绑定的 Provider ID",
  "path": "可选，工作空间绑定的根路径"
}}
```

**字段说明：**
- `id` — 自动生成的 UUID
- `name` — 工作空间名称（同时也是 workspaces/ 下的目录名）
- `alias` — 可选显示别名
- `projects` — 项目列表，每个项目有 id、path（绝对路径）、alias
- `providerId` — 绑定的 API Provider ID（对应 providers.json 中的 id）
- `path` — 工作空间绑定的根路径（用于目录扫描导入项目）

### providers.json

```json
[
  {{
    "id": "uuid-string",
    "name": "Provider 名称",
    "providerType": "anthropic",
    "apiKey": "sk-ant-...",
    "baseUrl": null,
    "modelId": null,
    "isDefault": true,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }}
]
```

**providerType 可选值：**
| 类型 | 说明 | 需要字段 |
|------|------|---------|
| `anthropic` | Anthropic 官方 API | apiKey |
| `openrouter` | OpenRouter 聚合 | apiKey |
| `aws-bedrock` | AWS Bedrock | apiKey (AWS credentials) |
| `gcp-vertex` | GCP Vertex AI | apiKey (GCP credentials) |
| `custom` | 自定义 API 端点 | apiKey, baseUrl |

⚠️ **安全提示**：providers.json 包含 API Key，查看时请脱敏处理，不要在输出中完整显示密钥。

## 数据库表结构 (data.db)

使用 `sqlite3 data.db` 打开数据库。

### projects
| 列名 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 项目 ID |
| name | TEXT NOT NULL | 项目名称 |
| path | TEXT NOT NULL UNIQUE | 项目路径 |
| created_at | TEXT NOT NULL | 创建时间 |
| alias | TEXT | 别名 |

### launch_history
| 列名 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | 记录 ID |
| project_id | TEXT NOT NULL | 项目 ID |
| project_name | TEXT NOT NULL | 项目名称 |
| project_path | TEXT NOT NULL | 项目路径 |
| launched_at | TEXT NOT NULL | 启动时间 |
| claude_session_id | TEXT | Claude 会话 ID |
| last_prompt | TEXT | 最后提示 |
| workspace_name | TEXT | 工作空间名称 |
| workspace_path | TEXT | 工作空间路径 |
| launch_cwd | TEXT | 启动目录 |

### todos
| 列名 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | Todo ID |
| title | TEXT NOT NULL | 标题 |
| description | TEXT | 描述 |
| status | TEXT NOT NULL DEFAULT 'todo' | 状态 (todo/in_progress/done) |
| priority | TEXT NOT NULL DEFAULT 'medium' | 优先级 (low/medium/high/urgent) |
| scope | TEXT NOT NULL DEFAULT 'global' | 范围 (global/workspace/project) |
| scope_ref | TEXT | 范围引用（工作空间名或项目路径） |
| tags | TEXT DEFAULT '[]' | JSON 标签数组 |
| due_date | TEXT | 截止日期 |
| sort_order | INTEGER NOT NULL DEFAULT 0 | 排序 |
| created_at | TEXT NOT NULL | 创建时间 |
| updated_at | TEXT NOT NULL | 更新时间 |
| my_day | INTEGER DEFAULT 0 | 我的一天标记 |
| my_day_date | TEXT | 我的一天日期 |
| reminder_at | TEXT | 提醒时间 |
| recurrence | TEXT | 重复规则 |

### todo_subtasks
| 列名 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 子任务 ID |
| todo_id | TEXT NOT NULL FK→todos.id | 所属 Todo |
| title | TEXT NOT NULL | 标题 |
| completed | INTEGER NOT NULL DEFAULT 0 | 是否完成 |
| sort_order | INTEGER NOT NULL DEFAULT 0 | 排序 |
| created_at | TEXT NOT NULL | 创建时间 |

## 常用操作指南

### Todo 管理

```bash
# 查询所有 Todo（概览）
sqlite3 data.db "SELECT id, title, status, priority, scope FROM todos ORDER BY sort_order"

# 查询未完成的 Todo
sqlite3 data.db "SELECT title, priority, scope FROM todos WHERE status != 'done' ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END"

# 按工作空间筛选 Todo
sqlite3 data.db "SELECT title, status, priority FROM todos WHERE scope='workspace' AND scope_ref='工作空间名'"

# 按项目筛选 Todo
sqlite3 data.db "SELECT title, status, priority FROM todos WHERE scope='project' AND scope_ref='项目路径'"

# 添加 Todo
sqlite3 data.db "INSERT INTO todos (id, title, status, priority, scope, sort_order, created_at, updated_at) VALUES (lower(hex(randomblob(16))), '新任务标题', 'todo', 'medium', 'global', 0, datetime('now'), datetime('now'))"

# 添加带描述和标签的 Todo
sqlite3 data.db "INSERT INTO todos (id, title, description, status, priority, scope, tags, sort_order, created_at, updated_at) VALUES (lower(hex(randomblob(16))), '任务标题', '详细描述', 'todo', 'high', 'global', '[\"tag1\",\"tag2\"]', 0, datetime('now'), datetime('now'))"

# 更新 Todo 状态
sqlite3 data.db "UPDATE todos SET status='done', updated_at=datetime('now') WHERE id='<todo-id>'"

# 更新 Todo 为进行中
sqlite3 data.db "UPDATE todos SET status='in_progress', updated_at=datetime('now') WHERE id='<todo-id>'"

# 删除 Todo（级联删除子任务）
sqlite3 data.db "DELETE FROM todo_subtasks WHERE todo_id='<todo-id>'; DELETE FROM todos WHERE id='<todo-id>'"

# 查询 Todo 的子任务
sqlite3 data.db "SELECT s.title, s.completed FROM todo_subtasks s WHERE s.todo_id='<todo-id>' ORDER BY s.sort_order"

# 添加子任务
sqlite3 data.db "INSERT INTO todo_subtasks (id, todo_id, title, completed, sort_order, created_at) VALUES (lower(hex(randomblob(16))), '<todo-id>', '子任务标题', 0, 0, datetime('now'))"

# Todo 完成率统计
sqlite3 data.db "SELECT status, COUNT(*) as count, ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM todos), 1) as pct FROM todos GROUP BY status"

# 按优先级统计
sqlite3 data.db "SELECT priority, COUNT(*) FROM todos WHERE status != 'done' GROUP BY priority"

# 查询今日 My Day
sqlite3 data.db "SELECT title, status, priority FROM todos WHERE my_day=1 AND my_day_date=date('now')"
```

### 项目管理

```bash
# 列出所有项目
sqlite3 data.db "SELECT name, path, alias, created_at FROM projects ORDER BY name"

# 搜索项目（模糊匹配）
sqlite3 data.db "SELECT name, path FROM projects WHERE name LIKE '%关键词%' OR path LIKE '%关键词%'"

# 项目数量
sqlite3 data.db "SELECT COUNT(*) FROM projects"
```

### 启动历史

```bash
# 最近 10 条启动记录
sqlite3 data.db "SELECT project_name, launched_at, workspace_name FROM launch_history ORDER BY launched_at DESC LIMIT 10"

# 按项目统计启动频率
sqlite3 data.db "SELECT project_name, COUNT(*) as launches FROM launch_history GROUP BY project_name ORDER BY launches DESC"

# 按工作空间统计
sqlite3 data.db "SELECT workspace_name, COUNT(*) as launches FROM launch_history WHERE workspace_name IS NOT NULL GROUP BY workspace_name ORDER BY launches DESC"

# 最近 7 天启动统计
sqlite3 data.db "SELECT date(launched_at) as day, COUNT(*) FROM launch_history WHERE launched_at >= datetime('now', '-7 days') GROUP BY day ORDER BY day"

# 查看某项目的启动历史
sqlite3 data.db "SELECT launched_at, workspace_name, launch_cwd FROM launch_history WHERE project_name='项目名' ORDER BY launched_at DESC"
```

### 工作空间管理

```bash
# 列出所有工作空间目录
ls workspaces/

# 查看某工作空间配置
cat workspaces/<name>/workspace.json

# 查看某工作空间的项目列表（用 jq 或 python 解析 JSON）
# Windows PowerShell:
Get-Content workspaces\<name>\workspace.json | ConvertFrom-Json | Select-Object -ExpandProperty projects
```

### Provider 管理

```bash
# 查看 Provider 列表（脱敏）
# ⚠️ 请勿完整输出 apiKey 字段
cat providers.json

# 检查默认 Provider
# 在 JSON 中查找 "isDefault": true 的条目
```

### 数据维护

```bash
# 备份数据库
cp data.db data.db.bak

# 检查数据库大小
ls -lh data.db

# 检查数据库完整性
sqlite3 data.db "PRAGMA integrity_check"

# 查看表列表
sqlite3 data.db ".tables"

# 优化数据库（回收空间）
sqlite3 data.db "VACUUM"
```
"#,
        data_dir = data_dir_display,
        workspaces_section = workspaces_section,
    );

    std::fs::write(&claude_md_path, content)
        .map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;

    Ok(())
}

/// 校验复制的文件大小一致
fn verify_copy(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    let name = crate::utils::sanitize_path_display(src);
    if !dst.exists() {
        return Err(format!("Target file not found: {}", name).into());
    }

    let src_size = std::fs::metadata(src)
        .map_err(|e| format!("Failed to read source file metadata: {}", e))?
        .len();
    let dst_size = std::fs::metadata(dst)
        .map_err(|e| format!("Failed to read target file metadata: {}", e))?
        .len();

    if src_size != dst_size {
        return Err(format!(
            "File size mismatch: {} (source: {} bytes, target: {} bytes)",
            name, src_size, dst_size
        )
        .into());
    }

    Ok(())
}
