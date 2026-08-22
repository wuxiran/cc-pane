//! DeepSeek Harness（dsh）托管实例模型
//!
//! dsh 是 DeepSeek 官方的 agent harness，形态是 **profile 启动器**而非 TUI：
//! 随包只有 `web`（浏览器 UI）与 `headless`（一次性任务）两个 app bundle，
//! 没有可在 PTY 里渲染的界面。因此它不是一个 `CliTool` 变体，而是
//! 「CC-Panes 托管的本地 Web 服务 + 浏览器窗格」这一条独立形态。
//!
//! 注入面全部走 `--patch` overlay（优先级最高，可插入新行）与 `settings.yaml`，
//! **不改 dsh 一行代码、不碰用户的 `~/.dsh`**。

use serde::{Deserialize, Serialize};

/// 一个托管中的 dsh 实例。
///
/// **一个工作空间一个实例**，同工作空间的多个标签共享它。这个粒度是两条约束
/// 夹出来的：
///
/// - 不能更粗（比如全局一个）：dsh 的持久化走 `storage-json`，语义是
///   「内存态权威 + 每次写重发整个文件」，单写者模型且无跨进程锁。两个进程
///   共享一个 `$DSH_HOME` 能同时启动、零报错，但后写者会把前者的工作空间
///   整份覆盖——静默丢数据，没有任何信号。所以隔离必须落到进程级。
/// - 不能更细（比如每标签一个）：用户填的 API key 存在
///   `$DSH_HOME/.credentials.yaml`，工作区注册与会话历史也都在 `$DSH_HOME` 下。
///   每标签一份的话，每开一个新标签都要重填一次 key、重选一次工作区，
///   历史也各看各的。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshInstance {
    /// 该实例归属的工作空间键（`$DSH_HOME` 的目录名）
    pub workspace_key: String,
    /// 实际监听端口（`--port 0` 由 OS 分配后从 stdout 回读）
    pub port: u16,
    /// 子进程 pid
    pub pid: u32,
    /// 该实例独占的 `$DSH_HOME`
    pub dsh_home: String,
    /// 浏览器窗格要导航的地址
    pub url: String,
}

/// 启动一个实例所需的注入材料。
///
/// 四项注入共用一个 `--patch` 文件 + 一个 `settings.yaml`，由
/// `DshService` 在启动前生成到该实例的 `$DSH_HOME` 下。
#[derive(Debug, Clone, Default)]
pub struct DshLaunchSpec {
    /// ccpanes MCP 端点（含本次 launchId 与 token）。None 则不注入 MCP。
    pub mcp_url: Option<String>,
    /// skill 目录（走 `customSkillDirs`，rank 300）。空则不注入。
    pub skill_dirs: Vec<String>,
    /// Claude Code 形态的 hooks.json 路径（经 `dsh-hooks-claude-code` 桥）。
    pub hooks_config_path: Option<String>,
    /// 项目目录，同时作为 hook 的 `${CLAUDE_PROJECT_DIR}` 与会话工作目录。
    pub project_dir: Option<String>,
    /// 工作空间路径——**决定复用哪个实例**（见 `DshInstance` 的粒度说明）。
    /// 缺省时该标签落到共享的 "default" 实例，而不是自己开一个。
    pub workspace_path: Option<String>,
    /// 注入给子进程的环境变量（API key 等）。
    ///
    /// 凭据**只从这里走**，不写 `$DSH_HOME/.credentials.yaml`：进程环境是 dsh
    /// 凭据层级里优先级最高的一层，这样用户在 CC-Panes 配一次，所有标签都生效，
    /// 不必每开一个新标签重填一次 key。
    pub env: Vec<(String, String)>,
    /// `llm-pi-ai` 的 `providers` 配置。
    ///
    /// 走 patch 层而非 `settings.yaml`：后者是 dsh 自己的可读写状态文件，
    /// 我们整份覆盖会抹掉用户在它 UI 里改的设置。
    pub providers: Option<serde_json::Value>,
}
