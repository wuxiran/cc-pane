//! Orchestrator Bearer 令牌的共享句柄。
//!
//! 令牌可在运行中更换（设置 → 设备与访问 → 编排器 →「更换令牌」）：HTTP / MCP 路由、
//! 重负载门禁与 `OrchestratorService` 持有同一个句柄，每次鉴权都读当前值，
//! 换掉之后旧令牌在下一个请求就失效，不需要重启监听。

use std::sync::{Arc, RwLock};

#[derive(Debug, Clone)]
pub struct OrchestratorToken(Arc<RwLock<String>>);

impl OrchestratorToken {
    pub fn new(token: impl Into<String>) -> Self {
        Self(Arc::new(RwLock::new(token.into())))
    }

    /// 当前令牌（拷贝）。
    pub fn current(&self) -> String {
        self.0
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// 常量时间比较候选令牌与当前令牌。
    pub fn matches(&self, candidate: &str) -> bool {
        let current = self.0.read().unwrap_or_else(|error| error.into_inner());
        cc_panes_core::services::device_token_service::constant_time_eq(
            current.as_bytes(),
            candidate.as_bytes(),
        )
    }

    pub(crate) fn replace(&self, token: String) {
        *self.0.write().unwrap_or_else(|error| error.into_inner()) = token;
    }
}

impl From<String> for OrchestratorToken {
    fn from(token: String) -> Self {
        Self::new(token)
    }
}

impl From<&str> for OrchestratorToken {
    fn from(token: &str) -> Self {
        Self::new(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_the_rotated_value() {
        let token = OrchestratorToken::new("old");
        let shared = token.clone();
        assert!(shared.matches("old"));
        token.replace("new".into());
        assert!(!shared.matches("old"));
        assert!(shared.matches("new"));
        assert_eq!(shared.current(), "new");
    }

    #[test]
    fn orchestrator_rotation_invalidates_old_token_and_persists_new_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = crate::utils::AppPaths::new(Some(dir.path().to_string_lossy().to_string()));
        let data_dir = paths.data_dir().to_path_buf();
        std::fs::create_dir_all(&data_dir).expect("data dir");
        // 上一轮留下的 manifest：新实例会沿用其中的令牌
        cc_panes_core::utils::orchestrator_manifest_lifecycle::publish(
            &data_dir,
            serde_json::json!({"pid": 1, "startedAt": 1, "mcpServers": {"ccpanes": {
                "type": "http",
                "url": "http://127.0.0.1:47822/mcp?token=persisted-old",
                "headers": {"Authorization": "Bearer persisted-old"}}}}),
        )
        .expect("publish");
        let service = crate::services::OrchestratorService::new(&paths);
        assert_eq!(service.token(), "persisted-old");
        // 路由 / 重负载门禁持有的是同一个句柄
        let routes_handle = service.shared_token();

        let next = service.rotate_token(&data_dir).expect("rotate");
        assert_ne!(next, "persisted-old");
        assert_eq!(service.token(), next);
        assert!(
            !routes_handle.matches("persisted-old"),
            "old token must stop working"
        );
        assert!(routes_handle.matches(&next));
        // 重启后沿用新令牌，而不是把旧令牌复活
        let (_, persisted) = cc_panes_core::utils::orchestrator_manifest::read_endpoint(&data_dir)
            .expect("manifest");
        assert_eq!(persisted, next);
        let restarted = crate::services::OrchestratorService::new(&paths);
        assert_eq!(restarted.token(), next);
    }
}
