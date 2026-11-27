//! 「@引擎」的默认 Bot：Agent Chat 输入框里 `@Codex` 这类引擎提及，背后是一个
//! 自动创建的 Bot（`auto_created = true`）。同引擎同 cwd 只建一个，之后复用，
//! 线程长期记住——与手建 Bot 走同一条 `ask` 通路。

use std::path::Path;

use super::{normalized_cwd, Bot, BotService, NAME_MAX};
use crate::commands::engine_spec;
use crate::utils::AppResult;

/// 自动 Bot 的身份：同引擎 + 同 cwd（无 cwd = 家目录模式）。
fn is_engine_bot_for(bot: &Bot, engine_id: &str, cwd: Option<&str>) -> bool {
    bot.auto_created
        && bot.engine_id.trim() == engine_id
        && normalized_cwd(bot.cwd.as_deref()) == cwd
}

fn engine_bot_name(label: &str, engine_id: &str) -> String {
    let base = label.trim();
    let base = if base.is_empty() { engine_id } else { base };
    base.chars().take(NAME_MAX).collect()
}

impl BotService {
    /// 找到（或创建）该引擎在该 cwd 下的默认 Bot。cwd 不存在时退回家目录模式。
    pub async fn ensure_engine_bot(&self, engine_id: &str, cwd: Option<&str>) -> AppResult<Bot> {
        let engine_id = engine_id.trim();
        let cwd = normalized_cwd(cwd).filter(|cwd| Path::new(cwd).is_dir());
        let _guard = self.auto_create_lock.lock().await;
        if let Some(bot) = self
            .list_bots()
            .into_iter()
            .find(|bot| is_engine_bot_for(bot, engine_id, cwd))
        {
            return Ok(bot);
        }
        let engine = engine_spec(&self.app_paths, engine_id)?;
        let draft = Bot {
            id: String::new(),
            name: engine_bot_name(&engine.label, engine_id),
            avatar: String::new(),
            color: String::new(),
            persona: String::new(),
            engine_id: engine_id.to_string(),
            cwd: cwd.map(str::to_string),
            auto_approve_kinds: Vec::new(),
            acp_session_id: None,
            created_at: 0,
            updated_at: 0,
            auto_created: true,
        };
        self.save(draft).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::services::AcpChatService;
    use cc_panes_core::utils::AppPaths;

    fn service() -> (tempfile::TempDir, BotService) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().to_string_lossy().into_owned();
        let acp = Arc::new(AcpChatService::new(temp.path().join("agent-chats")));
        let service = BotService::new(
            temp.path().join("bots"),
            acp,
            Arc::new(AppPaths::new(Some(data))),
        );
        (temp, service)
    }

    #[test]
    fn name_falls_back_to_engine_id_and_is_bounded() {
        assert_eq!(engine_bot_name(" Codex ", "codex"), "Codex");
        assert_eq!(engine_bot_name("", "codex"), "codex");
        assert_eq!(
            engine_bot_name(&"长".repeat(60), "x").chars().count(),
            NAME_MAX
        );
    }

    #[tokio::test]
    async fn engine_bot_is_reused_per_engine_and_cwd() {
        let (temp, service) = service();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();

        let first = service
            .ensure_engine_bot("claude", Some(&repo))
            .await
            .unwrap();
        assert!(first.auto_created);
        assert_eq!(first.cwd.as_deref(), Some(repo.as_str()));
        let again = service
            .ensure_engine_bot("claude", Some(&format!(" {repo} ")))
            .await
            .unwrap();
        assert_eq!(again.id, first.id, "same engine + cwd reuses the bot");

        let home = service.ensure_engine_bot("claude", None).await.unwrap();
        assert_ne!(home.id, first.id, "different cwd gets its own bot");
        assert!(home.cwd.is_none());
        let missing = service
            .ensure_engine_bot("claude", Some("/definitely/not/here"))
            .await
            .unwrap();
        assert_eq!(missing.id, home.id, "missing cwd falls back to home mode");
        assert_eq!(service.list_bots().len(), 2);
    }

    #[tokio::test]
    async fn hand_made_bot_is_not_taken_over_and_flag_survives_edits() {
        let (_temp, service) = service();
        let mut manual = service.ensure_engine_bot("claude", None).await.unwrap();
        // 编辑器提交时带的 autoCreated 不算数：身份以磁盘为准。
        manual.persona = "be terse".into();
        manual.auto_created = false;
        let saved = service.save(manual.clone()).await.unwrap();
        assert!(saved.auto_created);

        let mut draft = saved.clone();
        draft.id = String::new();
        draft.auto_created = false;
        let hand = service.save(draft).await.unwrap();
        assert!(!hand.auto_created);
        let reused = service.ensure_engine_bot("claude", None).await.unwrap();
        assert_eq!(reused.id, saved.id);
    }

    #[tokio::test]
    async fn unknown_engine_is_rejected() {
        let (_temp, service) = service();
        assert!(service
            .ensure_engine_bot("no-such-engine", None)
            .await
            .is_err());
        assert!(service.list_bots().is_empty());
    }
}
