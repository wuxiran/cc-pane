//! REST `/api/launch-task` 的 launch_history 回写。
//!
//! 这条路径（ctl / 外部客户端 / 无 WebView 场景）原先**完全不写** launch_history：
//! 会话起得来，但 DB 里没有归属行，resume id 到达时 `bind_resume_id` 无行可更新，
//! 重启后这条会话无从 resume。前端的 `orchestrator-launch-task` 监听只负责建 tab，
//! 不写 history，等它回流也补不上——必须后端同步写。
//!
//! 单独成文件而非内联进 `orchestrator_service.rs`：那个文件已经一万四千行，
//! 且受行数棘轮约束。

use std::sync::Arc;

use cc_panes_core::services::LaunchHistoryService;
use tracing::warn;

/// 一次 REST 启动的回写输入。字段全部来自已解析好的请求 + 运行时决议结果。
pub struct RestLaunchRecord<'a> {
    pub project_id: &'a str,
    pub project_path: &'a str,
    pub session_id: &'a str,
    pub cli_tool: &'a str,
    pub runtime_kind: &'a str,
    pub wsl_distro: Option<&'a str>,
    pub workspace_name: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub provider_selection: Option<&'a str>,
    /// resume 启动时已知的 resume id：不必等 Claude hook / Codex OSC 回报。
    pub resume_id: Option<&'a str>,
}

/// 写入 launch_history，返回需要带回响应的降级说明。
///
/// 失败时不 kill 会话（用户的 agent 已经在跑，杀掉代价更大），但**不能静默**：
/// 无归属行 = 永远无法 resume，调用方必须知道自己拿到的是一条不可恢复的会话。
pub fn record_rest_launch(
    service: &Arc<LaunchHistoryService>,
    record: RestLaunchRecord<'_>,
) -> Option<String> {
    let project_name = std::path::Path::new(record.project_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(record.project_path);

    let mut degraded = None;
    if let Err(error) = service.add_with_pty_session(
        record.project_id,
        project_name,
        record.project_path,
        record.session_id,
        record.cli_tool,
        record.runtime_kind,
        record.wsl_distro,
        record.workspace_name,
        record.workspace_path,
        Some(record.project_path),
        record.provider_id,
        record.provider_selection,
        None,
        None,
    ) {
        warn!(
            project_id = %record.project_id,
            err = %error,
            "REST::launch_task failed to insert launch_history; session will not be resumable"
        );
        degraded = Some(format!(
            "会话已启动，但 launch_history 落库失败（{error}）：本会话无法 resume，重启后不会恢复。"
        ));
    }

    if let Some(resume_id) = record.resume_id.map(str::trim).filter(|id| !id.is_empty()) {
        if let Err(error) =
            service.update_resume_session_with_source_by_pty(record.session_id, resume_id, "issued")
        {
            warn!(
                session_id = %record.session_id,
                err = %error,
                "REST::launch_task failed to bind known resume id"
            );
        }
    }

    degraded
}

/// 合并运行时提示与降级说明，供响应的 `notice` 字段使用。
pub fn merge_notice(runtime_notice: Option<String>, degraded: Option<String>) -> Option<String> {
    match (runtime_notice, degraded) {
        (Some(runtime), Some(degraded)) => Some(format!("{runtime} {degraded}")),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_notice_keeps_both_sides() {
        assert_eq!(
            merge_notice(Some("runtime".into()), Some("degraded".into())),
            Some("runtime degraded".to_string())
        );
        assert_eq!(
            merge_notice(None, Some("degraded".into())),
            Some("degraded".to_string())
        );
        assert_eq!(
            merge_notice(Some("runtime".into()), None),
            Some("runtime".to_string())
        );
        assert_eq!(merge_notice(None, None), None);
    }
}
