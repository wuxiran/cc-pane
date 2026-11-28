//! 组网消息记录：本机收到的（inbound，供对端轮询回复）与本机发出的（outbox，
//! 供桌面「联系人」面板显示回复 / 待审批）。都在内存、有界——回复也在 Bot 的
//! ACP 事件环与历史里，这里只是索引。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::policy::RemotePolicy;

const INBOUND_CAPACITY: usize = 256;
const OUTBOX_CAPACITY: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeshMessageStatus {
    /// 已受理，排队等 Bot 空闲（前一轮还在跑）。
    Queued,
    Running,
    /// 有审批卡等人处理（ask_origin / allowlist 未命中）。
    WaitingPermission,
    Done,
    Failed,
}

impl MeshMessageStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
}

/// 消息来源（请求体里的 `from`，信息性；权威来源是设备令牌 → `origin`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeshFrom {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub request_key: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshError {
    pub code: String,
    pub message: String,
}

/// `GET /api/bots/{id}/messages/{promptId}` 的回包。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshMessage {
    pub prompt_id: String,
    pub trace_id: String,
    pub hops: u32,
    pub bot_id: String,
    pub chat_id: String,
    pub status: MeshMessageStatus,
    /// 生效的策略（`full` 对非设备令牌来源已降级）；本机 Bot → Bot 为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<RemotePolicy>,
    /// 权威来源：`device:<名>` / `mobile` / `bot:<id>` / `desktop`。
    pub origin: String,
    #[serde(default)]
    pub from: MeshFrom,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MeshError>,
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermission>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

/// 有界的按 key 索引表（插入序淘汰，优先淘汰已结束的）。
pub struct BoundedMap<T> {
    capacity: usize,
    inner: Mutex<(HashMap<String, T>, VecDeque<String>)>,
}

pub trait Terminal {
    fn terminal(&self) -> bool;
}

impl Terminal for MeshMessage {
    fn terminal(&self) -> bool {
        self.status.is_terminal()
    }
}

impl<T: Clone + Terminal> BoundedMap<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            inner: Mutex::new((HashMap::new(), VecDeque::new())),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (HashMap<String, T>, VecDeque<String>)> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn insert(&self, key: String, value: T) {
        let mut guard = self.lock();
        let (map, order) = &mut *guard;
        if map.insert(key.clone(), value).is_none() {
            order.push_back(key);
        }
        while map.len() > self.capacity {
            // 先淘汰最老的已结束条目；全都在途时才淘汰最老的。
            let victim = order
                .iter()
                .position(|k| map.get(k).is_some_and(Terminal::terminal))
                .unwrap_or(0);
            if let Some(k) = order.remove(victim) {
                map.remove(&k);
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<T> {
        self.lock().0.get(key).cloned()
    }

    pub fn update(&self, key: &str, f: impl FnOnce(&mut T)) -> Option<T> {
        let mut guard = self.lock();
        let value = guard.0.get_mut(key)?;
        f(value);
        Some(value.clone())
    }

    /// 插入序（新 → 旧）。
    pub fn list(&self) -> Vec<T> {
        let guard = self.lock();
        guard
            .1
            .iter()
            .rev()
            .filter_map(|k| guard.0.get(k).cloned())
            .collect()
    }

    pub fn count_where(&self, f: impl Fn(&T) -> bool) -> usize {
        self.lock().0.values().filter(|v| f(v)).count()
    }

    pub fn remove(&self, key: &str) -> Option<T> {
        let mut guard = self.lock();
        let removed = guard.0.remove(key);
        guard.1.retain(|k| k != key);
        removed
    }
}

pub fn inbound_store() -> BoundedMap<MeshMessage> {
    BoundedMap::new(INBOUND_CAPACITY)
}

/// 本机发出的一条消息（桌面「联系人」面板 / MCP message_contact）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    /// = promptId。
    pub id: String,
    /// `local` = 本机。
    pub device_id: String,
    pub device_name: String,
    pub bot_id: String,
    pub bot_name: String,
    pub text: String,
    pub trace_id: String,
    pub hops: u32,
    /// `desktop`（界面）或 `bot:<id>` / `mcp`（MCP 工具）。
    pub sender: String,
    pub status: MeshMessageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MeshError>,
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermission>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Terminal for OutboxEntry {
    fn terminal(&self) -> bool {
        self.status.is_terminal()
    }
}

pub fn outbox_store() -> BoundedMap<OutboxEntry> {
    BoundedMap::new(OUTBOX_CAPACITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, status: MeshMessageStatus) -> MeshMessage {
        MeshMessage {
            prompt_id: id.into(),
            trace_id: "t".into(),
            hops: 0,
            bot_id: "b".into(),
            chat_id: "bot-b".into(),
            status,
            policy: None,
            origin: "desktop".into(),
            from: MeshFrom::default(),
            reply: None,
            error: None,
            pending_permissions: vec![],
            created_at: 0,
            finished_at: None,
        }
    }

    #[test]
    fn bounded_map_evicts_finished_first() {
        let map = BoundedMap::new(2);
        map.insert("a".into(), message("a", MeshMessageStatus::Running));
        map.insert("b".into(), message("b", MeshMessageStatus::Done));
        map.insert("c".into(), message("c", MeshMessageStatus::Queued));
        assert!(map.get("a").is_some(), "in-flight entry survives");
        assert!(map.get("b").is_none(), "finished entry evicted first");
        assert_eq!(
            map.list()
                .iter()
                .map(|m| m.prompt_id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a"]
        );
        map.update("a", |m| m.status = MeshMessageStatus::Done);
        assert_eq!(map.get("a").unwrap().status, MeshMessageStatus::Done);
        assert_eq!(map.count_where(|m| !m.terminal()), 1);
    }

    #[test]
    fn message_serializes_camel_case() {
        let value =
            serde_json::to_value(message("p", MeshMessageStatus::WaitingPermission)).unwrap();
        assert_eq!(value["promptId"], "p");
        assert_eq!(value["status"], "waiting_permission");
        assert!(value.get("reply").is_none());
    }
}
