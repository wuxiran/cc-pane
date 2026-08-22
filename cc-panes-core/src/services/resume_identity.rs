//! resume id 身份事件的共享判据。
//!
//! daemon（留存/重放）与桌面（落库）都要按同一套来源优先级做取舍——两边各写一份
//! 必然漂移：daemon 若按"最后写入"留存，就会用低优先级的 rollout-scan 覆盖掉
//! 高优先级的 osc-title，断连重连后桌面重放的是那个被降级的值。

/// resume id 的来源可信度。数值越大越可信。
///
/// - `manual`：用户手动指定，最高
/// - `issued` / `osc-title`：确定性捕获（发号 / CLI 自报标题）
/// - `rollout-scan` / `backfill` / `pi-session-file`：事后扫描反查，可能命中相邻会话
/// - `rescue`：一次性补救，最弱
pub fn source_priority(source: &str) -> u8 {
    match source {
        "manual" => 40,
        "issued" | "osc-title" => 30,
        "rollout-scan" | "backfill" | "pi-session-file" => 10,
        "rescue" => 5,
        _ => 0,
    }
}

/// 同优先级时后来者是否覆盖（`>=`）：同一来源的重复上报视为等价刷新。
pub fn should_replace_source(existing: Option<&str>, incoming: &str) -> bool {
    existing
        .map(|source| source_priority(incoming) >= source_priority(source))
        .unwrap_or(true)
}

/// 留存/重放场景的取舍：**同优先级同值不覆盖**。
///
/// 与 `should_replace_source` 的 `>=` 刻意不同。留存是幂等语义——同一条事件被
/// 重复投递（live 一次 + 每次重连补拉一次）时必须是 no-op，否则每次重连都会
/// 重写一遍 DB、刷一遍 `history-updated`、打一遍日志。
pub fn should_retain_incoming(
    existing_source: Option<&str>,
    existing_resume_id: Option<&str>,
    incoming_source: &str,
    incoming_resume_id: &str,
) -> bool {
    match (existing_source, existing_resume_id) {
        (Some(source), Some(resume_id)) => {
            let incoming_priority = source_priority(incoming_source);
            let existing_priority = source_priority(source);
            if incoming_priority > existing_priority {
                return true;
            }
            // 同优先级：只有值真的变了才覆盖。相等即 no-op。
            incoming_priority == existing_priority && resume_id != incoming_resume_id
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_priority_source_wins() {
        assert!(should_retain_incoming(
            Some("rollout-scan"),
            Some("a"),
            "osc-title",
            "b"
        ));
        assert!(!should_retain_incoming(
            Some("osc-title"),
            Some("a"),
            "rollout-scan",
            "b"
        ));
    }

    /// 重复投递同一条事件必须是 no-op——这正是补拉幂等性的地基。
    #[test]
    fn identical_event_is_not_retained_again() {
        assert!(!should_retain_incoming(
            Some("issued"),
            Some("resume-1"),
            "issued",
            "resume-1"
        ));
    }

    #[test]
    fn same_priority_different_value_replaces() {
        assert!(should_retain_incoming(
            Some("issued"),
            Some("resume-1"),
            "osc-title",
            "resume-2"
        ));
    }

    #[test]
    fn missing_existing_always_retains() {
        assert!(should_retain_incoming(None, None, "rescue", "resume-1"));
    }

    #[test]
    fn pi_session_file_has_backfill_priority() {
        assert_eq!(
            source_priority("pi-session-file"),
            source_priority("backfill")
        );
        assert!(!should_replace_source(Some("issued"), "pi-session-file"));
    }
}
