use crate::utils::error::AppError;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tracing::{error, info, warn};

/// 单条迁移定义
struct Migration {
    version: i64,
    description: &'static str,
    up_sql: &'static str,
}

/// 版本化迁移列表（仅追加，不可修改已有项）
///
/// V1 = 初始表结构（projects + launch_history + todos + todo_subtasks）
/// V2 = launch_history 添加 claude_session_id / last_prompt / workspace_name / workspace_path / launch_cwd
/// V3 = todos 添加 my_day / my_day_date / reminder_at / recurrence
/// V4 = todos 添加 todo_type
/// V9 = launch_history/session_restore 统一 resume session 字段和运行环境
/// V10 = launch_history 添加 pty_session_id
/// V11 = launch_history 添加 wsl_distro
/// V12 = workspace snapshot identity on launch/restore records
/// V14 = LaunchProfile identity on launch/restore records
/// V15 = Provider selection mode on launch/restore records
/// V16 = task_bindings plan collaboration leader/worker fields
/// V17 = plans + plan_recall_dedup (plan-as-memory with recall stats)
/// V18 = usage_stats + usage_scan_state
/// V19 = usage_stats per-source-path schema
/// V20 = runner registry (runner_profiles + runner_instances + port_claims)
/// V21 = launch_history 添加 resume_source（resume id 来源：issued/osc-title/backfill/rescue/manual）
/// V22 = layout_snapshots shared desktop/Web pane layout state
/// V23 = 洗掉 launch_history 里被 CLI hook 回填污染的 `\\?\` 路径（数据迁移，非 schema）
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "initial tables: projects, launch_history, todos, todo_subtasks",
        up_sql: "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                alias TEXT
            );

            CREATE TABLE IF NOT EXISTS launch_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                launched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS todos (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo',
                priority TEXT NOT NULL DEFAULT 'medium',
                scope TEXT NOT NULL DEFAULT 'global',
                scope_ref TEXT,
                tags TEXT DEFAULT '[]',
                due_date TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS todo_subtasks (
                id TEXT PRIMARY KEY,
                todo_id TEXT NOT NULL,
                title TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
            );
        ",
    },
    Migration {
        version: 2,
        description: "launch_history: add claude_session_id, last_prompt, workspace_name, workspace_path, launch_cwd",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN claude_session_id TEXT;
            ALTER TABLE launch_history ADD COLUMN last_prompt TEXT;
            ALTER TABLE launch_history ADD COLUMN workspace_name TEXT;
            ALTER TABLE launch_history ADD COLUMN workspace_path TEXT;
            ALTER TABLE launch_history ADD COLUMN launch_cwd TEXT;
        ",
    },
    Migration {
        version: 3,
        description: "todos: add my_day, my_day_date, reminder_at, recurrence",
        up_sql: "
            ALTER TABLE todos ADD COLUMN my_day INTEGER DEFAULT 0;
            ALTER TABLE todos ADD COLUMN my_day_date TEXT;
            ALTER TABLE todos ADD COLUMN reminder_at TEXT;
            ALTER TABLE todos ADD COLUMN recurrence TEXT;
        ",
    },
    Migration {
        version: 4,
        description: "todos: add todo_type",
        up_sql: "
            ALTER TABLE todos ADD COLUMN todo_type TEXT DEFAULT '';
        ",
    },
    Migration {
        version: 5,
        description: "specs: create specs table",
        up_sql: "
            CREATE TABLE IF NOT EXISTS specs (
                id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                title TEXT NOT NULL,
                file_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                todo_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_specs_project_path ON specs(project_path);
            CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(project_path, status);
        ",
    },
    Migration {
        version: 6,
        description: "launch_history: add provider_id",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN provider_id TEXT;
        ",
    },
    Migration {
        version: 7,
        description: "terminal_sessions: session restore support",
        up_sql: "
            CREATE TABLE IF NOT EXISTS terminal_sessions (
                session_id TEXT PRIMARY KEY,
                tab_id TEXT NOT NULL,
                pane_id TEXT NOT NULL,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                workspace_path TEXT,
                provider_id TEXT,
                cli_tool TEXT NOT NULL DEFAULT 'none',
                resume_id TEXT,
                claude_session_id TEXT,
                ssh_config TEXT,
                custom_title TEXT,
                created_at TEXT NOT NULL,
                saved_at TEXT NOT NULL
            );
        ",
    },
    Migration {
        version: 8,
        description: "task_bindings: orchestration task binding support",
        up_sql: "
            CREATE TABLE IF NOT EXISTS task_bindings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                prompt TEXT,
                session_id TEXT,
                todo_id TEXT,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                cli_tool TEXT NOT NULL DEFAULT 'claude',
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER NOT NULL DEFAULT 0,
                completion_summary TEXT,
                exit_code INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_task_bindings_status ON task_bindings(status);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_project ON task_bindings(project_path);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_session ON task_bindings(session_id);
        ",
    },
    Migration {
        version: 9,
        description: "launch_history/terminal_sessions: add unified resume session fields",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN resume_session_id TEXT;
            ALTER TABLE launch_history ADD COLUMN cli_tool TEXT NOT NULL DEFAULT 'none';
            ALTER TABLE launch_history ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'local';

            UPDATE launch_history
            SET resume_session_id = claude_session_id
            WHERE resume_session_id IS NULL AND claude_session_id IS NOT NULL;

            UPDATE launch_history
            SET cli_tool = 'claude'
            WHERE resume_session_id IS NOT NULL AND (cli_tool IS NULL OR cli_tool = '' OR cli_tool = 'none');

            ALTER TABLE terminal_sessions ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'local';
        ",
    },
    Migration {
        version: 10,
        description: "launch_history: add pty_session_id",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN pty_session_id TEXT;
        ",
    },
    Migration {
        version: 11,
        description: "launch_history: add wsl_distro",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN wsl_distro TEXT;
        ",
    },
    Migration {
        version: 12,
        description: "workspace state identity on launch/restore records",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN workspace_session_id TEXT;
            ALTER TABLE terminal_sessions ADD COLUMN workspace_session_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_launch_history_workspace_session
                ON launch_history(workspace_session_id);
            CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace_session
                ON terminal_sessions(workspace_session_id);
        ",
    },
    Migration {
        version: 13,
        description: "rename workspace session identity to workspace snapshot identity",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN workspace_snapshot_id TEXT;
            ALTER TABLE terminal_sessions ADD COLUMN workspace_snapshot_id TEXT;
            UPDATE launch_history
            SET workspace_snapshot_id = workspace_session_id
            WHERE workspace_snapshot_id IS NULL AND workspace_session_id IS NOT NULL;
            UPDATE terminal_sessions
            SET workspace_snapshot_id = workspace_session_id
            WHERE workspace_snapshot_id IS NULL AND workspace_session_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_launch_history_workspace_snapshot
                ON launch_history(workspace_snapshot_id);
            CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace_snapshot
                ON terminal_sessions(workspace_snapshot_id);
        ",
    },
    Migration {
        version: 14,
        description: "launch profile identity on launch/restore records",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN launch_profile_id TEXT;
            ALTER TABLE terminal_sessions ADD COLUMN launch_profile_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_launch_history_launch_profile
                ON launch_history(launch_profile_id);
            CREATE INDEX IF NOT EXISTS idx_terminal_sessions_launch_profile
                ON terminal_sessions(launch_profile_id);
        ",
    },
    Migration {
        version: 15,
        description: "launch/restore records: add provider selection mode",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN provider_selection TEXT;
            ALTER TABLE terminal_sessions ADD COLUMN provider_selection TEXT;
        ",
    },
    Migration {
        version: 16,
        description: "task_bindings: add plan collaboration leader/worker fields",
        up_sql: "
            ALTER TABLE task_bindings ADD COLUMN role TEXT NOT NULL DEFAULT 'task';
            ALTER TABLE task_bindings ADD COLUMN parent_id TEXT;
            ALTER TABLE task_bindings ADD COLUMN plan_path TEXT;
            ALTER TABLE task_bindings ADD COLUMN normalized_plan_path TEXT;
            ALTER TABLE task_bindings ADD COLUMN pane_id TEXT;
            ALTER TABLE task_bindings ADD COLUMN tab_id TEXT;
            ALTER TABLE task_bindings ADD COLUMN resume_id TEXT;
            ALTER TABLE task_bindings ADD COLUMN metadata TEXT;

            CREATE INDEX IF NOT EXISTS idx_task_bindings_role ON task_bindings(role);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_parent ON task_bindings(parent_id);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_plan_path ON task_bindings(normalized_plan_path);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_resume ON task_bindings(resume_id);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_pane ON task_bindings(pane_id);
        ",
    },
    Migration {
        version: 17,
        description: "plans: plan-as-memory table with workspace/project scope and recall stats",
        up_sql: "
            CREATE TABLE IF NOT EXISTS plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_binding_id TEXT REFERENCES task_bindings(id) ON DELETE SET NULL,
                workspace_name TEXT,
                project_path TEXT NOT NULL,
                session_id TEXT,
                plan_path TEXT NOT NULL,
                archived_path TEXT NOT NULL,
                intent TEXT,
                tags_json TEXT,
                scope_json TEXT,
                risk TEXT,
                followups TEXT,
                recall_count INTEGER NOT NULL DEFAULT 0,
                last_recalled_at INTEGER,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                UNIQUE(archived_path)
            );

            CREATE INDEX IF NOT EXISTS idx_plans_workspace_created ON plans(workspace_name, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_plans_project_created ON plans(project_path, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_plans_recall ON plans(recall_count DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);

            CREATE TABLE IF NOT EXISTS plan_recall_dedup (
                session_id TEXT NOT NULL,
                plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
                first_recalled_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, plan_id)
            );
        ",
    },
    Migration {
        version: 18,
        description: "usage stats daily aggregates and jsonl scan state",
        up_sql: "
            CREATE TABLE IF NOT EXISTS usage_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                cli_tool TEXT NOT NULL,
                workspace_name TEXT NOT NULL,
                char_count INTEGER NOT NULL DEFAULT 0,
                token_input INTEGER NOT NULL DEFAULT 0,
                token_output INTEGER NOT NULL DEFAULT 0,
                token_cache_read INTEGER NOT NULL DEFAULT 0,
                token_cache_creation INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                UNIQUE(date, cli_tool, workspace_name)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_stats(date);
            CREATE INDEX IF NOT EXISTS idx_usage_stats_workspace_date
                ON usage_stats(workspace_name, date);

            CREATE TABLE IF NOT EXISTS usage_scan_state (
                jsonl_path TEXT PRIMARY KEY,
                last_byte_offset INTEGER NOT NULL,
                last_mtime_ms INTEGER NOT NULL,
                scanned_at TEXT NOT NULL
            );
        ",
    },
    Migration {
        version: 19,
        description: "usage_stats: per-source-path schema (idempotent jsonl rescan)",
        up_sql: "
            DROP TABLE IF EXISTS usage_stats;
            CREATE TABLE usage_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                cli_tool TEXT NOT NULL,
                workspace_name TEXT NOT NULL,
                source_path TEXT NOT NULL,
                char_count INTEGER NOT NULL DEFAULT 0,
                token_input INTEGER NOT NULL DEFAULT 0,
                token_output INTEGER NOT NULL DEFAULT 0,
                token_cache_read INTEGER NOT NULL DEFAULT 0,
                token_cache_creation INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                UNIQUE(date, cli_tool, workspace_name, source_path)
            );
            CREATE INDEX idx_usage_stats_date ON usage_stats(date);
            CREATE INDEX idx_usage_stats_workspace_date
                ON usage_stats(workspace_name, date);

            -- 清空 scan_state 触发所有 jsonl 重扫一次；新表 INSERT OR REPLACE 幂等，不会重复累加
            DELETE FROM usage_scan_state;
        ",
    },
    Migration {
        version: 20,
        description: "runner registry: profiles + instances + port_claims",
        up_sql: "
            CREATE TABLE IF NOT EXISTS runner_profiles (
                id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                cwd TEXT NOT NULL,
                runtime_kind TEXT NOT NULL,
                wsl_distro TEXT,
                ssh_machine_id TEXT,
                env_json TEXT,
                expected_ports_json TEXT,
                tool_hint TEXT,
                last_started_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(project_path, name)
            );

            CREATE TABLE IF NOT EXISTS runner_instances (
                id TEXT PRIMARY KEY,
                profile_id TEXT,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                session_id TEXT,
                root_pid INTEGER NOT NULL,
                runtime_kind TEXT NOT NULL,
                command TEXT NOT NULL,
                cwd TEXT NOT NULL,
                started_at TEXT NOT NULL,
                exited_at TEXT,
                exit_code INTEGER,
                status TEXT NOT NULL DEFAULT 'running',
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS port_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id TEXT REFERENCES runner_instances(id) ON DELETE CASCADE,
                pid INTEGER NOT NULL,
                port INTEGER NOT NULL,
                protocol TEXT NOT NULL,
                listen_addr TEXT,
                detected_at TEXT NOT NULL,
                UNIQUE(pid, port, protocol)
            );

            CREATE INDEX IF NOT EXISTS idx_runner_profiles_project
                ON runner_profiles(project_path);
            CREATE INDEX IF NOT EXISTS idx_runner_profiles_last_started
                ON runner_profiles(project_path, last_started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_runner_instances_project
                ON runner_instances(project_path);
            CREATE INDEX IF NOT EXISTS idx_runner_instances_status
                ON runner_instances(status);
            CREATE INDEX IF NOT EXISTS idx_runner_instances_session
                ON runner_instances(session_id);
            CREATE INDEX IF NOT EXISTS idx_port_claims_port
                ON port_claims(port);
            CREATE INDEX IF NOT EXISTS idx_port_claims_instance
                ON port_claims(instance_id);
        ",
    },
    Migration {
        version: 21,
        description: "launch_history: add resume_source (issued/osc-title/backfill/rescue/manual)",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN resume_source TEXT;
        ",
    },
    Migration {
        version: 22,
        description: "layout_snapshots: shared desktop/web pane layout state",
        up_sql: "
            CREATE TABLE IF NOT EXISTS layout_snapshots (
                profile_id TEXT PRIMARY KEY,
                workspace_id TEXT,
                workspace_name TEXT,
                payload_json TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                source TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_layout_snapshots_workspace
                ON layout_snapshots(workspace_id);
        ",
    },
    Migration {
        version: 23,
        description: "launch_history: strip \\\\?\\ verbatim prefix from launch_cwd/workspace_path",
        // 存量数据清洗（见 docs/35-unc-path-contamination.md）：CLI hook 的
        // `canonicalize()` 把 `\\?\C:\...` 回填进 launch_cwd，再经前端回流成 PTY cwd，
        // 被 cmd.exe 拒绝并静默回落 C:\Windows。
        //
        // 这条迁移会改用户真实数据，因此严格限定：
        //   * 只对**恰好**以 `\\?\` 开头的值做 substr(…, 5)，其余一字不动；
        //   * 排除 `\\?\UNC\`——它无法靠裸剥前缀降级成合法路径（与 dunce 语义一致）；
        //   * 天然幂等：剥完就不再匹配 WHERE，重复执行是 no-op。
        up_sql: "
            UPDATE launch_history
               SET launch_cwd = substr(launch_cwd, 5)
             WHERE launch_cwd IS NOT NULL
               AND substr(launch_cwd, 1, 4) = '\\\\?\\'
               AND substr(launch_cwd, 1, 8) <> '\\\\?\\UNC\\';

            UPDATE launch_history
               SET workspace_path = substr(workspace_path, 5)
             WHERE workspace_path IS NOT NULL
               AND substr(workspace_path, 1, 4) = '\\\\?\\'
               AND substr(workspace_path, 1, 8) <> '\\\\?\\UNC\\';
        ",
    },
];

/// 数据库连接管理
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 创建新的数据库连接
    pub fn new(db_path: PathBuf) -> Result<Self, AppError> {
        // 确保目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                error!(path = %parent.display(), err = %e, "Failed to create database directory");
                AppError::from(format!("Failed to create database directory: {}", e))
            })?;
        }

        let conn = Connection::open(&db_path).map_err(|e| {
            error!(path = %db_path.display(), err = %e, "Failed to open database");
            AppError::from(format!("Failed to open database: {}", e))
        })?;

        // WAL 模式：提升读写并发性能，减少写锁等待。
        // `journal_mode` pragma 会返回结果行，必须通过 query_row 读取。
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| {
            error!(err = %e, "Failed to enable WAL mode");
            AppError::from(format!("Failed to enable WAL mode: {}", e))
        })?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| {
                error!(err = %e, "Failed to set synchronous pragma");
                AppError::from(format!("Failed to set synchronous pragma: {}", e))
            })?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| {
                error!(err = %e, "Failed to set busy timeout");
                AppError::from(format!("Failed to set busy timeout: {}", e))
            })?;

        Self::run_migrations(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 降级到内存数据库（磁盘数据库失败时的 fallback）
    pub fn new_fallback() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory().map_err(|e| {
            error!(err = %e, "Failed to create fallback in-memory database");
            AppError::from(format!(
                "Failed to create fallback in-memory database: {}",
                e
            ))
        })?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 执行版本化数据库迁移
    fn run_migrations(conn: &Connection) -> Result<(), AppError> {
        // 确保 schema_migrations 表存在
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        )
        .map_err(|e| {
            error!(table = "schema_migrations", err = %e, "Failed to create schema_migrations table");
            AppError::from(format!("Failed to create schema_migrations table: {}", e))
        })?;

        let current_version = Self::get_current_version(conn)?;
        let pending: Vec<&Migration> = MIGRATIONS
            .iter()
            .filter(|m| m.version > current_version)
            .collect();

        if pending.is_empty() {
            info!(
                "Database schema is up to date (version {})",
                current_version
            );
            return Ok(());
        }

        info!(
            "Running {} pending migration(s) (current: v{}, target: v{})",
            pending.len(),
            current_version,
            pending.last().map(|m| m.version).unwrap_or(current_version),
        );

        for migration in pending {
            info!(
                "Applying migration v{}: {}",
                migration.version, migration.description
            );

            // 每条迁移在一个事务内执行，保证原子性
            let tx = conn.unchecked_transaction()
                .map_err(|e| {
                    error!(version = migration.version, err = %e, "Failed to begin transaction for migration");
                    AppError::from(format!("Failed to begin transaction for migration v{}: {}", migration.version, e))
                })?;

            // execute_batch 不支持事务内参数绑定，但对 DDL 语句足够
            // 对 ALTER TABLE 的 "duplicate column" 错误做容错处理（兼容旧数据库）
            match tx.execute_batch(migration.up_sql) {
                Ok(()) => {}
                Err(e) => {
                    let err_msg = e.to_string();
                    // SQLite 的 ALTER TABLE ADD COLUMN 对已存在列报 "duplicate column name"
                    if err_msg.contains("duplicate column name") {
                        warn!(
                            "Migration v{} encountered duplicate column (already applied partially), continuing",
                            migration.version
                        );
                    } else {
                        return Err(AppError::from(format!(
                            "Migration v{} failed: {}",
                            migration.version, e
                        )));
                    }
                }
            }

            tx.execute(
                "INSERT OR REPLACE INTO schema_migrations (version, description) VALUES (?1, ?2)",
                rusqlite::params![migration.version, migration.description],
            )
            .map_err(|e| {
                error!(table = "schema_migrations", version = migration.version, err = %e, "Failed to record migration");
                AppError::from(format!(
                    "Failed to record migration v{}: {}",
                    migration.version, e
                ))
            })?;

            tx.commit().map_err(|e| {
                error!(version = migration.version, err = %e, "Failed to commit migration");
                AppError::from(format!(
                    "Failed to commit migration v{}: {}",
                    migration.version, e
                ))
            })?;

            info!("Migration v{} applied successfully", migration.version);
        }

        Ok(())
    }

    /// 获取当前数据库版本号（0 表示全新数据库）
    fn get_current_version(conn: &Connection) -> Result<i64, AppError> {
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "schema_migrations", err = %e, "Failed to query schema version");
                AppError::from(format!("Failed to query schema version: {}", e))
            })?;
        Ok(version)
    }

    /// 创建内存数据库（用于测试）
    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, AppError> {
        Self::new_fallback()
    }

    /// 获取数据库连接的可变引用
    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.conn.lock().map_err(|_| {
            error!("Database lock poisoned");
            AppError::from("Database lock poisoned")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fresh_database_migrates_to_latest() {
        let db = Database::new_in_memory().expect("should create in-memory db");
        let conn = db.connection().expect("should get connection");
        let version = Database::get_current_version(&conn).expect("should get version");
        assert_eq!(version, MIGRATIONS.last().unwrap().version);
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let db = Database::new_in_memory().expect("first init");
        // 再次运行迁移应该不报错
        let conn = db.connection().expect("connection");
        Database::run_migrations(&conn).expect("second migration run should succeed");
    }

    #[test]
    fn test_schema_migrations_table_records_all_versions() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("should get connection");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("should count migrations");
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn test_all_tables_exist_after_migration() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("should get connection");

        let tables = [
            "projects",
            "launch_history",
            "todos",
            "todo_subtasks",
            "specs",
            "terminal_sessions",
            "task_bindings",
            "usage_stats",
            "usage_scan_state",
            "schema_migrations",
            "runner_profiles",
            "runner_instances",
            "port_claims",
            "layout_snapshots",
        ];
        for table in &tables {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            assert!(exists, "Table '{}' should exist", table);
        }
    }

    #[test]
    fn test_task_bindings_plan_collaboration_columns_exist() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("should get connection");
        let mut stmt = conn
            .prepare("PRAGMA table_info(task_bindings)")
            .expect("should prepare pragma");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("should collect columns");

        for expected in [
            "role",
            "parent_id",
            "plan_path",
            "normalized_plan_path",
            "pane_id",
            "tab_id",
            "resume_id",
            "metadata",
        ] {
            assert!(
                columns.iter().any(|column| column == expected),
                "task_bindings should have column '{}'",
                expected
            );
        }
    }

    /// V23 数据清洗：对存量污染行剥 `\\?\`，且重复执行幂等。
    /// 见 docs/35-unc-path-contamination.md。
    #[test]
    fn migration_v23_strips_verbatim_prefix_and_is_idempotent() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("conn");

        // 迁移已在建库时跑过，这里手动种入污染行再重放 v23 的 SQL。
        conn.execute_batch(
            r"
            INSERT INTO launch_history (project_id, project_name, project_path, launched_at, launch_cwd, workspace_path)
            VALUES
              ('dirty',      'p', 'C:\p', '2026-01-01', '\\?\C:\Users\me\proj', '\\?\C:\ws'),
              ('clean',      'p', 'C:\p', '2026-01-01', 'C:\Users\me\proj',     'C:\ws'),
              ('unc',        'p', 'C:\p', '2026-01-01', '\\?\UNC\server\share', NULL),
              ('unixish',    'p', '/p',   '2026-01-01', '/home/me/proj',        NULL);
            ",
        )
        .expect("seed");

        let v23 = MIGRATIONS
            .iter()
            .find(|m| m.version == 23)
            .expect("v23 exists");

        let read = |id: &str| -> (Option<String>, Option<String>) {
            conn.query_row(
                "SELECT launch_cwd, workspace_path FROM launch_history WHERE project_id = ?1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row")
        };

        for pass in 1..=2 {
            conn.execute_batch(v23.up_sql).expect("apply v23");

            // 污染行被剥干净
            assert_eq!(
                read("dirty"),
                (
                    Some(r"C:\Users\me\proj".to_string()),
                    Some(r"C:\ws".to_string())
                ),
                "pass {pass}: dirty row should be stripped"
            );
            // 干净行、`\\?\UNC\` 行、Unix 风格路径一律不动
            assert_eq!(
                read("clean"),
                (
                    Some(r"C:\Users\me\proj".to_string()),
                    Some(r"C:\ws".to_string())
                ),
                "pass {pass}: clean row must not be rewritten"
            );
            assert_eq!(
                read("unc").0,
                Some(r"\\?\UNC\server\share".to_string()),
                "pass {pass}: \\\\?\\UNC\\ cannot be naively stripped"
            );
            assert_eq!(
                read("unixish").0,
                Some("/home/me/proj".to_string()),
                "pass {pass}: unix path must not be rewritten"
            );
        }
    }
}
