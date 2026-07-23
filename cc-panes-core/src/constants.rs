//! 全局常量集中管理
//!
//! 将散落在各模块中的魔法数字统一定义在此，
//! 便于查找、修改和保持一致性。

/// 文件系统操作限制
pub mod fs_limits {
    /// 最大可读文件大小 (10 MB)
    pub const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

    /// 最大可写文件大小 (10 MB)
    pub const MAX_WRITE_SIZE: usize = 10 * 1024 * 1024;

    /// 单层目录最大条目数
    pub const MAX_DIR_ENTRIES: usize = 5_000;
}

/// Local History 模块常量
pub mod history {
    /// Diff 最大行数（超过则截断）
    pub const MAX_DIFF_LINES: usize = 10_000;

    /// Diff 上下文行数
    pub const CONTEXT_LINES: usize = 3;

    /// 文件事件 Debounce 窗口（毫秒）
    pub const DEBOUNCE_MS: u64 = 500;

    /// 分支切换后的静默窗口（秒），抑制 checkout 产生的文件事件
    pub const CHECKOUT_SILENCE_SECS: u64 = 3;
}

/// Journal 模块常量
pub mod journal {
    /// 单个 Journal 文件最大行数
    pub const MAX_LINES: usize = 2_000;
}

/// 事件名称常量（前后端共享协议）
pub mod events {
    pub const TERMINAL_OUTPUT: &str = "terminal-output";
    pub const TERMINAL_EXIT: &str = "terminal-exit";
    pub const TERMINAL_STATUS: &str = "terminal-status";
    pub const WORKSPACES_CHANGED: &str = "workspaces-changed";
    pub const SESSION_KILLED: &str = "session-killed";
    /// 会话的 agent resume id 已确定性获得（Claude 发号 / Codex OSC 标题捕获）。
    /// 后端监听此事件写入 launch_history 并转发 history-updated 给前端。
    pub const TERMINAL_RESUME_ID_DETECTED: &str = "terminal-resume-id-detected";
    /// 启动时的非致命警告（前端 toast 提示）。当前用于：显式选中的启动配置因
    /// CLI/运行环境不匹配被丢弃、已回落到默认配置（YOLO 等 profile 级设置可能未生效）。
    pub const TERMINAL_LAUNCH_WARNING: &str = "terminal-launch-warning";
}

/// 终端默认值
pub mod terminal {
    /// 默认回滚缓冲行数
    pub const DEFAULT_SCROLLBACK: u32 = 20_000;

    /// v0.9.38 及更早版本的默认回滚缓冲行数。
    pub const LEGACY_DEFAULT_SCROLLBACK: u32 = 1_000;
}
