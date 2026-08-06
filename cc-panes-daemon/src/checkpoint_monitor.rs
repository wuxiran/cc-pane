//! 补拍周期扫描（M3b-2）。
//!
//! 前端拍照上传后，会话继续产出的 delta 会越攒越大；超过阈值时经 control
//! 广播 `{"type":"checkpointRequest","sessionId"}` 催前端重拍。语义要点：
//! - **无照片不催**——首拍由前端边沿触发（`TerminalService::sessions_needing_checkpoint`
//!   已内置该判定）；
//! - best-effort：单次丢失无补救，条件仍满足时下一轮扫描重发（契约表
//!   `terminal-checkpoint-request` 的 `BestEffortWithResend`）；
//! - 每会话节流 ≥60s，不挂输出热路径（独立线程，形态同 session_reaper）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cc_panes_core::services::TerminalService;
use tracing::debug;

use crate::ws_emitter::WsEmitter;

const SCAN_INTERVAL: Duration = Duration::from_secs(30);
/// pushed_seq − 照片锚点超过该值才催（M3b 设计定值 4MB）。
const CHECKPOINT_DELTA_THRESHOLD_BYTES: u64 = 4 * 1024 * 1024;
/// 同一会话两次补拍请求的最小间隔。
const PER_SESSION_THROTTLE: Duration = Duration::from_secs(60);

/// 纯判定：候选中过滤掉节流窗口内已催过的会话，并把放行的记入节流表。
/// 同时清掉节流表里已不在候选中的过期项，防 map 随会话生灭无界增长。
pub fn select_throttled(
    candidates: Vec<String>,
    last_requested: &mut HashMap<String, Instant>,
    now: Instant,
    throttle: Duration,
) -> Vec<String> {
    last_requested.retain(|session_id, requested_at| {
        candidates.contains(session_id) || now.saturating_duration_since(*requested_at) < throttle
    });
    candidates
        .into_iter()
        .filter(|session_id| {
            let recently = last_requested
                .get(session_id)
                .is_some_and(|at| now.saturating_duration_since(*at) < throttle);
            if recently {
                return false;
            }
            last_requested.insert(session_id.clone(), now);
            true
        })
        .collect()
}

/// 30s 周期扫描线程（形态同 `session_reaper::spawn_session_reaper`）。
pub fn spawn_checkpoint_monitor(service: Arc<TerminalService>, emitter: Arc<WsEmitter>) {
    std::thread::spawn(move || {
        let mut last_requested: HashMap<String, Instant> = HashMap::new();
        loop {
            std::thread::sleep(SCAN_INTERVAL);
            let candidates = service.sessions_needing_checkpoint(CHECKPOINT_DELTA_THRESHOLD_BYTES);
            if candidates.is_empty() {
                continue;
            }
            let now = Instant::now();
            for session_id in
                select_throttled(candidates, &mut last_requested, now, PER_SESSION_THROTTLE)
            {
                debug!(session_id, "requesting checkpoint refresh from clients");
                emitter.publish_checkpoint_request(&session_id);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_passes_and_is_recorded() {
        let mut last = HashMap::new();
        let now = Instant::now();
        let selected = select_throttled(
            vec!["s1".to_string(), "s2".to_string()],
            &mut last,
            now,
            Duration::from_secs(60),
        );
        assert_eq!(selected, vec!["s1".to_string(), "s2".to_string()]);
        assert!(last.contains_key("s1") && last.contains_key("s2"));
    }

    #[test]
    fn requests_within_throttle_window_are_suppressed() {
        let mut last = HashMap::new();
        let start = Instant::now();
        select_throttled(
            vec!["s1".to_string()],
            &mut last,
            start,
            Duration::from_secs(60),
        );

        // 30s 后仍在候选：节流压住。
        let selected = select_throttled(
            vec!["s1".to_string()],
            &mut last,
            start + Duration::from_secs(30),
            Duration::from_secs(60),
        );
        assert!(selected.is_empty(), "60s 内不得重复催同一会话");

        // 节流窗过后放行。
        let selected = select_throttled(
            vec!["s1".to_string()],
            &mut last,
            start + Duration::from_secs(61),
            Duration::from_secs(60),
        );
        assert_eq!(selected, vec!["s1".to_string()]);
    }

    #[test]
    fn stale_entries_outside_candidates_are_pruned() {
        let mut last = HashMap::new();
        let start = Instant::now();
        select_throttled(
            vec!["gone".to_string()],
            &mut last,
            start,
            Duration::from_secs(60),
        );

        // 会话已不在候选且节流窗已过：节流表条目应被清理。
        select_throttled(
            vec!["other".to_string()],
            &mut last,
            start + Duration::from_secs(120),
            Duration::from_secs(60),
        );
        assert!(!last.contains_key("gone"), "节流表不得随会话生灭无界增长");
    }
}
