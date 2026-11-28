//! 移动桥对 chat 服务的只读视图（docs/112 §3.3/§3.4）。
//!
//! 活会话列表与事件订阅给 orchestrator `/acp/*` 路由用；写操作仍走服务的
//! 常规方法，所以手机与桌面标签驱动的是同一个 chat。

use super::event_log::{ReplayPlan, Subscription};
use super::*;
use crate::services::bot_service::BOT_CHAT_PREFIX;

/// 手机端新建的 chat id 前缀（`origin=mobile` 的判据）。
pub const MOBILE_CHAT_PREFIX: &str = "mobile-";

/// chat 的创建来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatOrigin {
    Desktop,
    Mobile,
    Bot,
}

impl ChatOrigin {
    pub fn for_chat_id(chat_id: &str) -> Self {
        if chat_id.starts_with(MOBILE_CHAT_PREFIX) {
            Self::Mobile
        } else if chat_id.starts_with(BOT_CHAT_PREFIX) {
            Self::Bot
        } else {
            Self::Desktop
        }
    }
}

/// `GET /acp/chats` 的一行：进程仍在服务表里的会话（含已退出未回收的）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLiveChat {
    pub chat_id: String,
    pub engine_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    pub status: AcpChatPhase,
    pub last_seq: u64,
    pub origin: ChatOrigin,
    pub pending_permissions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    pub updated_at: i64,
}

struct LiveRow {
    snapshot: AcpChatSnapshot,
    cwd: PathBuf,
    pending: usize,
}

impl AcpChatService {
    pub async fn list_live_chats(&self) -> Vec<AcpLiveChat> {
        let mut rows = Vec::new();
        let native: Vec<_> = self
            .native_sessions
            .read()
            .await
            .values()
            .cloned()
            .collect();
        for session in native {
            rows.push(LiveRow {
                snapshot: session.snapshot().await,
                cwd: session.cwd().to_path_buf(),
                pending: session.pending_approvals().await,
            });
        }
        let acp: Vec<_> = self.sessions.read().await.values().cloned().collect();
        for session in acp {
            rows.push(LiveRow {
                snapshot: session.snapshot().await,
                cwd: session.cwd.clone(),
                pending: session.pending_permissions.pending_count().await,
            });
        }
        let mut chats: Vec<AcpLiveChat> = rows.into_iter().map(|row| self.live_row(row)).collect();
        chats.sort_by_key(|chat| std::cmp::Reverse(chat.updated_at));
        chats
    }

    fn live_row(&self, row: LiveRow) -> AcpLiveChat {
        let LiveRow {
            snapshot,
            cwd,
            pending,
        } = row;
        let info = self.event_tap.hub().info(&snapshot.chat_id);
        let title = snapshot
            .acp_session_id
            .as_deref()
            .and_then(|id| self.meta_path(id))
            .and_then(|path| read_meta(&path))
            .and_then(|meta| {
                meta.get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|title| !title.trim().is_empty());
        let origin = ChatOrigin::for_chat_id(&snapshot.chat_id);
        let bot_id = snapshot
            .chat_id
            .strip_prefix(BOT_CHAT_PREFIX)
            .map(str::to_string);
        AcpLiveChat {
            origin,
            bot_id,
            last_seq: info.map_or(0, |info| info.last_seq),
            updated_at: info.map_or(0, |info| info.updated_at),
            pending_permissions: pending,
            cwd: cwd.to_string_lossy().into_owned(),
            title,
            acp_session_id: snapshot.acp_session_id,
            status: snapshot.phase,
            engine_id: snapshot.engine_id,
            chat_id: snapshot.chat_id,
        }
    }

    /// 当前事件环最后一条 seq（chat 尚无事件时 0）。
    pub fn last_event_seq(&self, chat_id: &str) -> u64 {
        self.event_tap
            .hub()
            .info(chat_id)
            .map_or(0, |info| info.last_seq)
    }

    /// 该 chat 是否已接纳过这个 promptId（手机端重试幂等）。
    pub fn has_prompt(&self, chat_id: &str, prompt_id: &str) -> bool {
        self.event_tap.hub().has_prompt(chat_id, prompt_id)
    }

    /// 订阅实时并取续传计划（同一把锁）。chat 从未产生事件时 None。
    pub fn subscribe_events(&self, chat_id: &str, after_seq: u64) -> Option<Subscription> {
        self.event_tap.hub().subscribe(chat_id, after_seq)
    }

    /// 广播落后（Lagged）后的补读。
    pub fn replay_events(
        &self,
        chat_id: &str,
        after_seq: u64,
    ) -> Option<(ReplayPlan, Option<Value>)> {
        self.event_tap.hub().replay(chat_id, after_seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_follows_chat_id_prefix() {
        assert_eq!(ChatOrigin::for_chat_id("mobile-1"), ChatOrigin::Mobile);
        assert_eq!(ChatOrigin::for_chat_id("bot-alice"), ChatOrigin::Bot);
        assert_eq!(ChatOrigin::for_chat_id("tab-1"), ChatOrigin::Desktop);
    }
}
