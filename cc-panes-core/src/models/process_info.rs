use serde::Serialize;

/// Claude 相关进程的类型分类
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeProcessType {
    /// Claude CLI 主进程
    ClaudeCli,
    /// Claude 启动的 Node.js 子进程
    ClaudeNode,
    /// MCP Server 进程
    McpServer,
    /// 其他相关进程
    Other,
}

/// 单个 Claude 相关进程的信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    pub memory_bytes: u64,
    pub start_time: u64,
    pub process_type: ClaudeProcessType,
}

/// 进程扫描结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessScanResult {
    pub processes: Vec<ClaudeProcess>,
    pub total_count: usize,
    pub total_memory_bytes: u64,
    pub scanned_at: String,
}
