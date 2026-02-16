//! CC-Panes TUI - 工作空间级别的 Claude 启动器
//!
//! 分屏模式：上方显示工作空间信息，下方是 Claude CLI 的 PTY 输出

mod app;
mod git;
mod ipc;
mod journal;
mod models;
mod pty;
mod session;
mod terminal;
mod ui;
mod utils;
mod workspace;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "cc-panes-tui")]
#[command(about = "工作空间级别的 Claude 启动器（分屏 TUI 模式）")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 启动 TUI 界面
    Run {
        /// 工作空间目录路径
        #[arg(long)]
        workspace_dir: String,

        /// IPC 监听端口
        #[arg(long, default_value_t = ipc::DEFAULT_PORT)]
        port: u16,
    },
    /// 发送状态通知到 TUI
    Notify {
        /// 状态: completed, failed, working, blocked, waiting, permission
        #[arg(long)]
        status: String,

        /// 可选消息
        #[arg(long)]
        message: Option<String>,

        /// IPC 端口（未指定时从 CC_PANES_PORT 环境变量读取，再回退到默认值）
        #[arg(long)]
        port: Option<u16>,
    },
    /// 初始化 Claude Code 钩子配置
    Init {
        /// 目标目录（默认当前目录）
        #[arg(long, default_value = ".")]
        dir: String,

        /// IPC 端口
        #[arg(long, default_value_t = ipc::DEFAULT_PORT)]
        port: u16,

        /// 强制覆盖已有配置
        #[arg(long)]
        force: bool,
    },
    /// 记录工作日志
    Record {
        /// 工作空间目录
        #[arg(long, default_value = ".")]
        workspace_dir: String,

        /// 会话标题
        #[arg(long)]
        title: String,

        /// 摘要描述
        #[arg(long)]
        summary: Option<String>,

        /// Git commit hash（可多次指定）
        #[arg(long)]
        commit: Vec<String>,

        /// 会话 ID（用于关联）
        #[arg(long)]
        session_id: Option<String>,
    },
    /// 保存会话状态（供钩子调用）
    SaveSession {
        /// 工作空间目录
        #[arg(long, default_value = ".")]
        workspace_dir: String,

        /// 会话 ID
        #[arg(long)]
        session_id: String,

        /// 状态: active, completed
        #[arg(long, default_value = "active")]
        status: String,
    },
}

fn main() -> Result<()> {
    let args = Args::parse();

    match args.command {
        Command::Run { workspace_dir, port } => run_tui(&workspace_dir, port),
        Command::Notify { status, message, port } => {
            let port = port
                .or_else(|| std::env::var("CC_PANES_PORT").ok()?.parse().ok())
                .unwrap_or(ipc::DEFAULT_PORT);
            ipc::send_notify(port, &status, message.as_deref())
        }
        Command::Init { dir, port, force } => init_hooks(&dir, port, force),
        Command::Record {
            workspace_dir,
            title,
            summary,
            commit,
            session_id,
        } => record_session(&workspace_dir, &title, summary, commit, session_id),
        Command::SaveSession {
            workspace_dir,
            session_id,
            status,
        } => save_session_state(&workspace_dir, &session_id, &status),
    }
}

fn run_tui(workspace_dir: &str, port: u16) -> Result<()> {
    // 设置环境变量供 app 使用
    std::env::set_var("CC_PANES_WORKSPACE_DIR", workspace_dir);
    std::env::set_var("CC_PANES_PORT", port.to_string());

    // 读取 workspace.json
    let ws = workspace::load(workspace_dir)?;

    // 初始化终端
    let terminal = ratatui::init();

    // 运行 TUI 应用
    let app = app::App::new(ws, port);
    let exit_code = app.run(terminal)?;

    // 恢复终端
    ratatui::restore();

    std::process::exit(exit_code);
}

/// 初始化 Claude Code 钩子配置
fn init_hooks(dir: &str, port: u16, force: bool) -> Result<()> {
    use std::fs;
    use std::path::Path;

    let base_path = Path::new(dir);
    let claude_dir = base_path.join(".claude");
    let settings_path = claude_dir.join("settings.json");

    // 检查是否已存在配置
    if settings_path.exists() && !force {
        anyhow::bail!(
            "配置文件已存在: {}\n使用 --force 覆盖",
            settings_path.display()
        );
    }

    // 创建 .claude 目录
    if !claude_dir.exists() {
        fs::create_dir_all(&claude_dir)?;
    }

    // 生成钩子配置
    let config = generate_hooks_config(port);

    // 写入配置文件
    fs::write(&settings_path, config)?;

    println!("已创建钩子配置: {}", settings_path.display());
    println!("配置的钩子:");
    println!("  - Stop: 保存会话状态并通知 TUI");
    println!("  - SessionStart: 记录会话 ID");
    println!("  - Notification: 等待用户输入时通知 TUI");

    Ok(())
}

/// 生成钩子配置 JSON
/// 注意：钩子中不再包含 --port，notify 命令会从 CC_PANES_PORT 环境变量自动读取端口
fn generate_hooks_config(_port: u16) -> String {
    let exe_name = "cc-panes-tui";

    format!(
        r#"{{
  "hooks": {{
    "Stop": [
      {{
        "matcher": "*",
        "hooks": [
          {{
            "type": "command",
            "command": "{exe} save-session --workspace-dir . --session-id $CLAUDE_SESSION_ID --status completed"
          }},
          {{
            "type": "command",
            "command": "{exe} notify --status completed --message \"任务完成\""
          }}
        ]
      }}
    ],
    "SessionStart": [
      {{
        "matcher": "*",
        "hooks": [
          {{
            "type": "command",
            "command": "{exe} save-session --workspace-dir . --session-id $CLAUDE_SESSION_ID --status active"
          }}
        ]
      }}
    ],
    "Notification": [
      {{
        "matcher": "*",
        "hooks": [
          {{
            "type": "command",
            "command": "{exe} notify --status waiting --message \"等待用户输入\""
          }}
        ]
      }}
    ]
  }}
}}"#,
        exe = exe_name,
    )
}

/// 记录工作日志
fn record_session(
    workspace_dir: &str,
    title: &str,
    summary: Option<String>,
    commits: Vec<String>,
    _session_id: Option<String>,
) -> Result<()> {
    use journal::{RecordStatus, SessionRecord};

    // 获取下一个会话编号
    let number = journal::next_session_number(workspace_dir)?;

    // 获取当前日期
    let date = utils::current_date();

    // 创建会话记录
    let record = SessionRecord {
        number,
        title: title.to_string(),
        date,
        summary: summary.unwrap_or_default(),
        commits,
        status: RecordStatus::Completed,
    };

    // 添加到日志
    journal::add_session(workspace_dir, &record)?;

    println!("已记录会话 #{}: {}", number, title);
    println!("日志文件: {}", journal::index_path(workspace_dir).display());

    Ok(())
}

/// 保存会话状态
fn save_session_state(workspace_dir: &str, session_id: &str, status: &str) -> Result<()> {
    let state = match status {
        "completed" => {
            // 加载现有状态并标记为完成
            if let Ok(Some(mut state)) = session::load_session(workspace_dir) {
                state.mark_completed();
                state
            } else {
                let mut state = session::SessionState::new(session_id.to_string());
                state.mark_completed();
                state
            }
        }
        _ => {
            // 创建或更新活跃会话
            session::SessionState::new(session_id.to_string())
        }
    };

    session::save_session(workspace_dir, &state)?;
    Ok(())
}
