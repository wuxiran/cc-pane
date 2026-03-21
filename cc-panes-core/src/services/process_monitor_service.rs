use crate::models::process_info::{ClaudeProcess, ClaudeProcessType, ProcessScanResult};
use crate::utils::error::AppResult;
use parking_lot::Mutex;
use sysinfo::{System, Pid};
use tracing::{debug, warn};

/// 系统级 Claude Code 进程监控服务
pub struct ProcessMonitorService {
    sys: Mutex<System>,
}

impl Default for ProcessMonitorService {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessMonitorService {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
        }
    }

    /// 当前进程的 PID（用于自身保护）
    fn self_pid() -> u32 {
        std::process::id()
    }

    /// 扫描系统中所有 Claude 相关进程
    pub fn scan_claude_processes(&self) -> AppResult<ProcessScanResult> {
        let mut sys = self.sys.lock();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let self_pid = Self::self_pid();
        let mut processes = Vec::new();

        for (pid, process) in sys.processes() {
            // 排除自身进程
            if pid.as_u32() == self_pid {
                continue;
            }

            let name = process.name().to_string_lossy().to_string();
            let cmd_parts: Vec<String> = process.cmd().iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            let command = cmd_parts.join(" ");

            if let Some(process_type) = Self::classify_process(&name, &command) {
                let cwd = process.cwd().map(|p| p.to_string_lossy().to_string());
                let parent_pid = process.parent().map(|p| p.as_u32());

                processes.push(ClaudeProcess {
                    pid: pid.as_u32(),
                    parent_pid,
                    name,
                    command,
                    cwd,
                    memory_bytes: process.memory(),
                    start_time: process.start_time(),
                    process_type,
                });
            }
        }

        let total_count = processes.len();
        let total_memory_bytes: u64 = processes.iter().map(|p| p.memory_bytes).sum();
        let scanned_at = chrono::Utc::now().to_rfc3339();

        debug!(
            total_count = total_count,
            total_memory_bytes = total_memory_bytes,
            "scan_claude_processes completed"
        );

        Ok(ProcessScanResult {
            processes,
            total_count,
            total_memory_bytes,
            scanned_at,
        })
    }

    /// 终止单个进程
    pub fn kill_process(&self, pid: u32) -> AppResult<bool> {
        // 自身保护
        if pid == Self::self_pid() {
            warn!(pid = pid, "kill_process: refused to kill self");
            return Ok(false);
        }

        let mut sys = self.sys.lock();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, false);

        let sysinfo_pid = Pid::from_u32(pid);
        if let Some(process) = sys.process(sysinfo_pid) {
            let result = Self::kill_process_cross_platform(process);
            debug!(pid = pid, success = result, "kill_process");
            Ok(result)
        } else {
            debug!(pid = pid, "kill_process: process not found");
            Ok(false)
        }
    }

    /// 批量终止进程
    pub fn kill_processes(&self, pids: Vec<u32>) -> AppResult<Vec<(u32, bool)>> {
        let self_pid = Self::self_pid();
        let mut sys = self.sys.lock();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, false);

        let results: Vec<(u32, bool)> = pids.iter().map(|&pid| {
            // 自身保护
            if pid == self_pid {
                warn!(pid = pid, "kill_processes: refused to kill self");
                return (pid, false);
            }

            let sysinfo_pid = Pid::from_u32(pid);
            let success = if let Some(process) = sys.process(sysinfo_pid) {
                Self::kill_process_cross_platform(process)
            } else {
                false
            };
            (pid, success)
        }).collect();

        debug!(count = results.len(), "kill_processes batch completed");
        Ok(results)
    }

    /// 跨平台 kill 进程：Windows 上直接 kill，Unix 上先 SIGTERM 再 SIGKILL
    fn kill_process_cross_platform(process: &sysinfo::Process) -> bool {
        #[cfg(unix)]
        {
            use sysinfo::Signal;
            // Unix: 优先 SIGTERM（优雅退出），失败再 SIGKILL
            process.kill_with(Signal::Term).unwrap_or(false)
                || process.kill()
        }
        #[cfg(not(unix))]
        {
            // Windows: 没有 SIGTERM，直接 TerminateProcess
            process.kill()
        }
    }

    /// 分类进程类型：通过进程名和命令行判断
    fn classify_process(name: &str, command: &str) -> Option<ClaudeProcessType> {
        let name_lower = name.to_lowercase();
        let cmd_lower = command.to_lowercase();

        // Claude CLI 主进程
        if name_lower == "claude" || name_lower == "claude.exe" {
            return Some(ClaudeProcessType::ClaudeCli);
        }

        // Node.js 进程 — 需要进一步检查命令行
        if name_lower == "node" || name_lower == "node.exe" {
            // MCP Server 进程（检查更具体的模式以减少误匹配）
            if cmd_lower.contains("mcp-server") || cmd_lower.contains("mcp_server")
                || cmd_lower.contains("model-context-protocol")
            {
                return Some(ClaudeProcessType::McpServer);
            }
            // Claude 启动的 Node.js 子进程
            if cmd_lower.contains("claude") || cmd_lower.contains("@anthropic") {
                return Some(ClaudeProcessType::ClaudeNode);
            }
            return None;
        }

        // 其他进程名中包含 claude 的
        if name_lower.contains("claude") {
            return Some(ClaudeProcessType::Other);
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_claude_cli() {
        assert_eq!(
            ProcessMonitorService::classify_process("claude", "claude chat"),
            Some(ClaudeProcessType::ClaudeCli)
        );
        assert_eq!(
            ProcessMonitorService::classify_process("claude.exe", "claude.exe --help"),
            Some(ClaudeProcessType::ClaudeCli)
        );
    }

    #[test]
    fn test_classify_claude_node() {
        assert_eq!(
            ProcessMonitorService::classify_process("node", "node /path/to/@anthropic/claude-code/cli.js"),
            Some(ClaudeProcessType::ClaudeNode)
        );
        assert_eq!(
            ProcessMonitorService::classify_process("node.exe", "node.exe C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.mjs"),
            Some(ClaudeProcessType::ClaudeNode)
        );
    }

    #[test]
    fn test_classify_mcp_server() {
        assert_eq!(
            ProcessMonitorService::classify_process("node", "node /path/to/mcp-server/index.js"),
            Some(ClaudeProcessType::McpServer)
        );
    }

    #[test]
    fn test_classify_unrelated_node() {
        assert_eq!(
            ProcessMonitorService::classify_process("node", "node /path/to/my-app/server.js"),
            None
        );
        // "mcp" 子串不再误匹配，需要 "mcp-server" / "mcp_server"
        assert_eq!(
            ProcessMonitorService::classify_process("node", "node /path/to/my-amcp-tool.js"),
            None
        );
    }

    #[test]
    fn test_classify_unrelated_process() {
        assert_eq!(
            ProcessMonitorService::classify_process("firefox", "firefox https://example.com"),
            None
        );
    }
}
