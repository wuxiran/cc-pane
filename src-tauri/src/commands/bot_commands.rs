//! Bot 联系人命令。会话本体仍走 `*_acp_chat` 命令（chatId = `bot-{id}`），
//! 这里只管 Bot 记录与「按记住的线程拉起」。
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::services::bot_service::emit_changed;
use crate::services::bot_service::BotAskReply;
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

/// Agent Chat 里的 `@Bot`：交给 Bot 跑一轮（排队等它空闲），返回回复。
/// `ask_id` 由前端生成，用于取消与把 Bot 对话里的公告对上卡片。
#[tauri::command]
pub async fn ask_bot(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    ask_id: String,
    bot_id: String,
    text: String,
    from_chat_id: String,
) -> AppResult<BotAskReply> {
    let service = service.inner().clone();
    service
        .ask(&app, &ask_id, &bot_id, &text, &from_chat_id)
        .await
}

/// 取消在途的 `@Bot` 请求；已结束 / 未知返回 false。
#[tauri::command]
pub async fn cancel_bot_ask(
    service: State<'_, Arc<BotService>>,
    ask_id: String,
) -> AppResult<bool> {
    Ok(service.cancel_ask(&ask_id))
}

/// 「@引擎」：找到或创建该引擎在该 cwd 下的默认 Bot。
#[tauri::command]
pub async fn ensure_engine_bot(
    app: AppHandle,
    service: State<'_, Arc<BotService>>,
    engine_id: String,
    cwd: Option<String>,
) -> AppResult<Bot> {
    let before = service.list_bots().len();
    let bot = service
        .ensure_engine_bot(&engine_id, cwd.as_deref())
        .await?;
    if service.list_bots().len() != before {
        emit_changed(&app);
    }
    Ok(bot)
}
