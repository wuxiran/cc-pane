use crate::models::settings::PushChannel;
use crate::services::NotificationService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 测试 Push 推送渠道
///
/// 发送测试消息到指定渠道，验证配置是否正确。
/// 注意：此操作为同步阻塞调用，直接在当前线程发送 HTTP 请求。
#[tauri::command]
pub fn test_push(
    service: State<'_, Arc<NotificationService>>,
    channel_config: PushChannel,
) -> AppResult<bool> {
    debug!("cmd::test_push");
    service
        .test_push_channel(&channel_config)
        .map(|()| true)
        .map_err(|e| e.into())
}
