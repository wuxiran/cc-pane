use crate::models::process_info::{ClaudeProcess, ClaudeProcessType, ProcessScanResult, ResourceStats};
use crate::utils::error::AppResult;
use parking_lot::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tracing::{debug, warn};

/// 系统级 Claude Code 进程监控服务
pub struct ProcessMonitorService {
    sys: Mutex<System>,
    /// 缓存的活跃 PID 列表（由 TerminalService 注入）
    tracked_pids: Mutex<Vec<Pid>>,
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
            tracked_pids: Mutex::new(Vec::new()),
        }
    }

    /// 更新跟踪的 PID 列表（从 TerminalService 注入活跃 session 的根 PID）
    pub fn update_tracked_pids(&self, pids: Vec<u32>) {
        let mut tracked = self.tracked_pids.lock();
        *tracked = pids.into_iter().map(Pid::from_u32).collect();
    }

    /// 轻量级增量刷新：仅刷新已跟踪 PID 的 CPU/内存，返回聚合统计
    pub fn refresh_resource_stats(&self) -> AppResult<ResourceStats> {
        let tracked = self.tracked_pids.lock().clone();

        if tracked.is_empty() {
            return Ok(ResourceStats {
                total_cpu_percent: 0.0,
                total_memory_bytes: 0,
                process_count: 0,
                timestamp: Self::now_millis(),
            });
        }

        let mut sys = self.sys.lock();
        // 仅刷新指定 PID 的 CPU 和内存（不读取命令行/环境变量等）
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&tracked),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        let mut total_cpu: f32 = 0.0;
        let mut total_mem: u64 = 0;
        let mut count: u32 = 0;

        for pid in &tracked {
            if let Some(process) = sys.process(*pid) {
                total_cpu += process.cpu_usage();
                total_mem += process.memory();
                count += 1;
            }
        }

        Ok(ResourceStats {
            total_cpu_percent: total_cpu,
            total_memory_bytes: total_mem,
            process_count: count,
            timestamp: Self::now_millis(),
        })
    }

    fn now_millis() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// 当前进程的 PID（用于自身保护）
    fn self_pid() -> u32 {
        std::process::id()
    }

    /// 扫描系统中所有 Claude 相关进程
    pub fn scan_claude_processes(&self) -> AppResult<ProcessScanResult> {
        let mut sys = self.sys.lock();
        sys.refresh_processes(ProcessesToUpdate::All, true);

        let self_pid = Self::self_pid();
        let mut processes = Vec::new();

        for (pid, process) in sys.processes() {
            // 排除自身进程
            if pid.as_u32() == self_pid {
                continue;
            }

            let name = process.name().to_string_lossy().to_string();
            let cmd_parts: Vec<String> = process
                .cmd()
                .iter()
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
        sys.refresh_processes(ProcessesToUpdate::All, false);

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
        sys.refresh_processes(ProcessesToUpdate::All, false);

        let results: Vec<(u32, bool)> = pids
            .iter()
            .map(|&pid| {
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
            })
            .collect();

        debug!(count = results.len(), "kill_processes batch completed");
        Ok(results)
    }

    /// 跨平台 kill 进程：Windows 上直接 kill，Unix 上先 SIGTERM 再 SIGKILL
    fn kill_process_cross_platform(process: &sysinfo::Process) -> bool {
        #[cfg(unix)]
        {
            use sysinfo::Signal;
            // Unix: 优先 SIGTERM（优雅退出），失败再 SIGKILL
            process.kill_with(Signal::Term).unwrap_or(false) || process.kill()
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
            if cmd_lower.contains("mcp-server")
                || cmd_lower.contains("mcp_server")
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
            ProcessMonitorService::classify_process(
                "node",
                "node /path/to/@anthropic/claude-code/cli.js"
            ),
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
