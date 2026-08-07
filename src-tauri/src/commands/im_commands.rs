use crate::services::im_bridge::{ImBridgeService, ImChannelStatus};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 向指定渠道发一条测试消息（无视 enabled 主开关，配置期即可验证）
#[tauri::command]
pub async fn test_im_channel(
    im_bridge: State<'_, Arc<ImBridgeService>>,
    channel_id: String,
) -> AppResult<()> {
    debug!(channel_id = %channel_id, "cmd::test_im_channel");
    im_bridge
        .test_channel(&channel_id)
        .await
        .map_err(Into::into)
}

/// 各渠道最近一次发送结果
#[tauri::command]
pub fn get_im_bridge_status(
    im_bridge: State<'_, Arc<ImBridgeService>>,
) -> AppResult<Vec<ImChannelStatus>> {
    Ok(im_bridge.status())
}
