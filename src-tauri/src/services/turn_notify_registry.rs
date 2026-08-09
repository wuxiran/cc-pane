//! 「本轮已富通知」标记注册表 — AI 富摘要通知与状态机 turn_end 兜底的互斥契约。
//!
//! AI 在回复过程中经 trigger_notification（kind=turn_end + sessionId）打标记；
//! Stop hook 触发的状态机 → Idle 跃迁必然晚于标记写入，两个兜底消费者
//! （桌面 sync listener / IM broadcast task）查到标记即跳过兜底通知。
//! 消费者到达顺序不定，因此查而不删；标记的失效路径是下一轮开始
//! （Idle → 忙碌跃迁时 clear）+ 会话退出 clear + TTL 兜底防泄漏。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MARK_TTL: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy)]
pub struct TurnMark {
    pub at: Instant,
    /// 富通知是否实际通过了 IM 转发闸门。IM 兜底只在 true 时跳过——
    /// forward_ai_notify=false 时富通知没进 IM，基础 IM 通知不能被冤枉跳过。
    pub im_forwarded: bool,
}

#[derive(Debug, Default)]
pub struct TurnNotifyRegistry {
    marks: Mutex<HashMap<String, TurnMark>>,
}

impl TurnNotifyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark(&self, session_id: &str, im_forwarded: bool) {
        let mut marks = self.marks.lock().unwrap_or_else(|e| e.into_inner());
        marks.insert(
            session_id.to_string(),
            TurnMark {
                at: Instant::now(),
                im_forwarded,
            },
        );
    }

    /// 查标记（不删除）。过期条目视为不存在并顺手移除。
    pub fn is_marked(&self, session_id: &str) -> Option<TurnMark> {
        let mut marks = self.marks.lock().unwrap_or_else(|e| e.into_inner());
        match marks.get(session_id) {
            Some(mark) if mark.at.elapsed() <= MARK_TTL => Some(*mark),
            Some(_) => {
                marks.remove(session_id);
                None
            }
            None => None,
        }
    }

    pub fn clear(&self, session_id: &str) {
        let mut marks = self.marks.lock().unwrap_or_else(|e| e.into_inner());
        marks.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_then_is_marked_returns_flag() {
        let reg = TurnNotifyRegistry::new();
        reg.mark("s1", true);
        let mark = reg.is_marked("s1").expect("should be marked");
        assert!(mark.im_forwarded);
        // 查不删：再查仍在
        assert!(reg.is_marked("s1").is_some());
    }

    #[test]
    fn im_forwarded_false_is_preserved() {
        let reg = TurnNotifyRegistry::new();
        reg.mark("s1", false);
        let mark = reg.is_marked("s1").expect("should be marked");
        assert!(!mark.im_forwarded);
    }

    #[test]
    fn clear_removes_mark() {
        let reg = TurnNotifyRegistry::new();
        reg.mark("s1", true);
        reg.clear("s1");
        assert!(reg.is_marked("s1").is_none());
    }

    #[test]
    fn unmarked_session_returns_none() {
        let reg = TurnNotifyRegistry::new();
        assert!(reg.is_marked("nope").is_none());
    }

    #[test]
    fn remark_overwrites_flag() {
        let reg = TurnNotifyRegistry::new();
        reg.mark("s1", false);
        reg.mark("s1", true);
        assert!(reg.is_marked("s1").expect("marked").im_forwarded);
    }

    #[test]
    fn expired_mark_treated_as_absent() {
        let reg = TurnNotifyRegistry::new();
        reg.marks.lock().unwrap().insert(
            "s1".to_string(),
            TurnMark {
                at: Instant::now() - MARK_TTL - Duration::from_secs(1),
                im_forwarded: true,
            },
        );
        assert!(reg.is_marked("s1").is_none());
        // 过期条目已被顺手移除
        assert!(reg.marks.lock().unwrap().is_empty());
    }
}
