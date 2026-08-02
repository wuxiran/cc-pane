//! 会话级资源策略：让一个窗格里的 `cargo build` 不至于拖垮整机。
//!
//! 设计要点见 `docs/71-multi-pane-resource-contention.md`：
//! - **只降优先级，不设天花板**。目标是防失控，正常工作该跑多快还多快。
//! - **内存不进执行面**。Windows 的 `JOB_OBJECT_LIMIT_JOB_MEMORY` 与
//!   `_JOB_MEMORY_HIGH` 是同一个值（512），只有硬限一种——超限即分配失败，
//!   用户看到的是"莫名其妙的 build 失败"且不会联想到是我们设的。内存一律
//!   降级为观测 + 告警。
//! - **降级必须可见**（docs/45 教训）：每次应用策略都产出 [`PolicyOutcome`]。

use serde::{Deserialize, Serialize};

/// CPU 权重的中性值（不偏不倚，等同于不设）。
pub const CPU_WEIGHT_NEUTRAL: u8 = 5;
/// CPU 权重下界（最弱）。
pub const CPU_WEIGHT_MIN: u8 = 1;
/// CPU 权重上界（最强）。
pub const CPU_WEIGHT_MAX: u8 = 9;

/// cgroup `cpu.weight` 与本刻度的换算系数：本刻度 5（中性）→ cgroup 100（中性）。
const CGROUP_WEIGHT_SCALE: u16 = 20;

/// 单个 PTY 会话的资源策略。
///
/// 刻度统一采用 **Windows Job 的 1..=9（中性 5）**，因为它是三个平台里最窄的；
/// cgroup 的 1..=10000 由 [`Self::cgroup_cpu_weight`] 放大还原。换算只允许出现
/// 在本类型的方法里——各处自行折算必然出现"两边默认值对不上"的偏差。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResourcePolicy {
    /// 降低调度优先级。Windows → Job 的 `BELOW_NORMAL_PRIORITY_CLASS`；
    /// WSL / Unix → `nice`。
    ///
    /// 保持 bool 而非 enum：Windows 上只有 `BELOW_NORMAL` 一档是安全的，
    /// `IDLE` 会被后台任务饿死。
    pub lower_priority: bool,
    /// CPU 相对权重（[`CPU_WEIGHT_MIN`]..=[`CPU_WEIGHT_MAX`]）。
    /// `None` 表示不设——与显式给中性值等价，但省掉一次系统调用。
    pub cpu_weight: Option<u8>,
}

impl Default for SessionResourcePolicy {
    fn default() -> Self {
        // 默认只降优先级：收益/风险比最高，且不影响吞吐（空闲核照样跑满）。
        Self {
            lower_priority: true,
            cpu_weight: None,
        }
    }
}

impl SessionResourcePolicy {
    /// 完全不干预（用于关闭开关、或平台不支持时的占位）。
    pub fn disabled() -> Self {
        Self {
            lower_priority: false,
            cpu_weight: None,
        }
    }

    /// 是否什么都不用做——省掉一次系统调用，也让日志不产生噪声。
    pub fn is_noop(&self) -> bool {
        !self.lower_priority && self.effective_cpu_weight().is_none()
    }

    /// 收敛后的 CPU 权重：越界值 clamp 回合法区间，中性值视同不设。
    pub fn effective_cpu_weight(&self) -> Option<u8> {
        let weight = self.cpu_weight?.clamp(CPU_WEIGHT_MIN, CPU_WEIGHT_MAX);
        (weight != CPU_WEIGHT_NEUTRAL).then_some(weight)
    }

    /// 换算成 cgroup v2 的 `cpu.weight`（1..=10000，中性 100）。
    pub fn cgroup_cpu_weight(&self) -> Option<u16> {
        self.effective_cpu_weight()
            .map(|weight| u16::from(weight) * CGROUP_WEIGHT_SCALE)
    }

    /// WSL / Unix 侧 `nice` 的增量。仅 `lower_priority` 时生效。
    ///
    /// 取 5 而非 19：19 等同于 Windows 的 `IDLE`，会在持续满载时被饿死。
    pub fn nice_increment(&self) -> Option<i8> {
        self.lower_priority.then_some(5)
    }
}

/// 应用一次策略的结果。**必须回传前端**——只有输入没有产出，就会变成
/// docs/45 那种"功能死了没人知道"的静默降级。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PolicyOutcome {
    /// 完整生效。
    Applied,
    /// 部分生效或完全未生效，但会话正常启动（fail-open）。
    Degraded { reason: String },
    /// 当前平台不支持该策略，非错误。
    Unsupported,
}

impl PolicyOutcome {
    pub fn degraded(reason: impl Into<String>) -> Self {
        Self::Degraded {
            reason: reason.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_lowers_priority_without_touching_cpu() {
        let policy = SessionResourcePolicy::default();
        assert!(policy.lower_priority);
        assert_eq!(policy.cpu_weight, None);
        assert_eq!(policy.cgroup_cpu_weight(), None);
        assert!(!policy.is_noop());
    }

    #[test]
    fn disabled_is_noop() {
        assert!(SessionResourcePolicy::disabled().is_noop());
    }

    #[test]
    fn neutral_weight_is_treated_as_unset() {
        // 中性值等同于不设：避免为"什么都不改"白发一次系统调用。
        let policy = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: Some(CPU_WEIGHT_NEUTRAL),
        };
        assert_eq!(policy.effective_cpu_weight(), None);
        assert!(policy.is_noop());
    }

    #[test]
    fn out_of_range_weight_is_clamped_not_rejected() {
        let low = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: Some(0),
        };
        assert_eq!(low.effective_cpu_weight(), Some(CPU_WEIGHT_MIN));

        let high = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: Some(200),
        };
        assert_eq!(high.effective_cpu_weight(), Some(CPU_WEIGHT_MAX));
    }

    #[test]
    fn cgroup_weight_maps_neutral_to_100() {
        // 本刻度 5 → cgroup 100，两边中性值必须对齐，否则默认配置就已经在偏袒。
        let scaled = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: Some(4),
        }
        .cgroup_cpu_weight();
        assert_eq!(scaled, Some(80));
        assert_eq!(u16::from(CPU_WEIGHT_NEUTRAL) * CGROUP_WEIGHT_SCALE, 100);
    }

    #[test]
    fn nice_increment_follows_lower_priority() {
        assert_eq!(SessionResourcePolicy::default().nice_increment(), Some(5));
        assert_eq!(SessionResourcePolicy::disabled().nice_increment(), None);
    }
}
