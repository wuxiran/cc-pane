//! Bot 联系人命令。会话本体仍走 `*_acp_chat` 命令（chatId = `bot-{id}`），
//! 这里只管 Bot 记录与「按记住的线程拉起」。
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::services::bot_service::emit_changed;
use crate::services::{AcpChatSnapshot, Bot, BotService, BotSummary};
use crate::utils::AppResult;

#[tauri::command]
pub async fn list_bots(service: State<'_, Arc<BotService>>) -> AppResult<Vec<BotSummary>> {
    Ok(service.list().await)
}

#[tauri::command]
pub async fn save_bot(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    bot: Bot,
) -> AppResult<Bot> {
    let saved = service.save(bot).await?;
    emit_changed(&app);
    Ok(saved)
}

#[tauri::command]
pub async fn delete_bot(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    bot_id: String,
) -> AppResult<()> {
    service.delete(&bot_id).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn start_bot_chat(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    bot_id: String,
) -> AppResult<AcpChatSnapshot> {
    service.ensure_started(&app, &bot_id).await
}

#[tauri::command]
pub async fn new_bot_thread(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    bot_id: String,
) -> AppResult<Bot> {
    let bot = service.new_thread(&bot_id).await?;
    emit_changed(&app);
    Ok(bot)
}
