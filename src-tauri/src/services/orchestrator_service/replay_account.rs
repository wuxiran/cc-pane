//! resume / fork 回到源会话当时用的供应商账号。
//!
//! 登录型账号各占一个 CLI 配置目录：换了账号，CLI 就到别的目录里找那段对话，要么找不到，
//! 要么悄悄换了身份。所以调用方只给了 resumeId / forkSessionId、没点名账号时，从启动历史
//! 里把「那次实际用的账号」放回请求。
//!
//! 这里只负责「放回去」，不负责兜底：账号后来被删了，解析层会报
//! `PROVIDER_ACCOUNT_NOT_FOUND`，由调用方原样返回——不会退回默认账号重试。

use cc_panes_core::models::LaunchProviderSelection;
use cc_panes_core::repository::LaunchRecord;
use cc_panes_core::services::LaunchHistoryService;

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// 按源会话的启动记录补全 `(provider_id, provider_account_id)`。
///
/// - 调用方点了名账号：不动（他说了算，解析层校验）。
/// - 调用方要原生启动（`providerSelection = none`）：不动。
/// - 调用方点名的供应商和记录里的不是同一个：不动——账号 id 只在它所属的供应商里有意义
///   （各家都有个叫 `default` 的账号），套到别家就是换了身份。
/// - 调用方没点名供应商：连同记录里的供应商一起放回，保证账号和供应商是当时那一对。
///   记录里没有供应商（当时是继承来的）时只放回账号，供应商照旧继承。
pub(super) fn apply_recorded_account(
    record: Option<&LaunchRecord>,
    selection: LaunchProviderSelection,
    provider_id: &mut Option<String>,
    provider_account_id: &mut Option<String>,
) {
    if non_empty(provider_account_id.as_deref()).is_some()
        || selection == LaunchProviderSelection::None
    {
        return;
    }
    let Some(record) = record else { return };
    let Some(recorded_account) = non_empty(record.provider_account_id.as_deref()) else {
        return;
    };
    let recorded_provider = non_empty(record.provider_id.as_deref());
    match (non_empty(provider_id.as_deref()), recorded_provider) {
        (None, recorded) => {
            if let Some(recorded) = recorded {
                *provider_id = Some(recorded.to_string());
            }
        }
        (Some(requested), Some(recorded)) if requested == recorded => {}
        (Some(_), _) => return,
    }
    *provider_account_id = Some(recorded_account.to_string());
}

/// 查出源会话（resume / fork 的来源）的启动记录并补全账号。查不到记录 = 不是 CC-Panes
/// 启动的会话或旧数据，保持原请求。
pub(super) fn replay_recorded_account(
    history: &LaunchHistoryService,
    source_session_id: Option<&str>,
    selection: LaunchProviderSelection,
    provider_id: &mut Option<String>,
    provider_account_id: &mut Option<String>,
) {
    let Some(source_session_id) = non_empty(source_session_id) else {
        return;
    };
    let record = history
        .find_by_resume_session_id(source_session_id)
        .ok()
        .flatten();
    apply_recorded_account(record.as_ref(), selection, provider_id, provider_account_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::repository::{Database, HistoryRepository};
    use std::sync::Arc;

    fn history_with(
        provider_id: Option<&str>,
        provider_account_id: Option<&str>,
    ) -> LaunchHistoryService {
        // 表在 `Database::new` 里建好；SQLite 句柄已打开，临时目录随后删掉不影响读写。
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Arc::new(Database::new(dir.path().join("history.db")).expect("db"));
        let service = LaunchHistoryService::new(Arc::new(HistoryRepository::new(db)));
        let id = service
            .add(
                "launch",
                "project",
                "/repo",
                "claude",
                "local",
                None,
                None,
                None,
                None,
                provider_id,
                provider_account_id,
                None,
                None,
                None,
                None,
            )
            .expect("add history");
        service
            .update_session_id(id, "conversation")
            .expect("bind resume id");
        service
    }

    fn replay(
        history: &LaunchHistoryService,
        selection: LaunchProviderSelection,
        provider_id: Option<&str>,
        provider_account_id: Option<&str>,
    ) -> (Option<String>, Option<String>) {
        let mut provider_id = provider_id.map(str::to_string);
        let mut provider_account_id = provider_account_id.map(str::to_string);
        replay_recorded_account(
            history,
            Some("conversation"),
            selection,
            &mut provider_id,
            &mut provider_account_id,
        );
        (provider_id, provider_account_id)
    }

    #[test]
    fn resume_puts_the_recorded_provider_and_account_back_into_the_request() {
        let history = history_with(Some("provider-a"), Some("work"));
        assert_eq!(
            replay(&history, LaunchProviderSelection::Inherit, None, None),
            (Some("provider-a".into()), Some("work".into()))
        );
        // 调用方点名了同一个供应商：只补账号
        assert_eq!(
            replay(
                &history,
                LaunchProviderSelection::Explicit,
                Some("provider-a"),
                None
            ),
            (Some("provider-a".into()), Some("work".into()))
        );
    }

    #[test]
    fn resume_keeps_an_inherited_provider_and_only_restores_the_account() {
        let history = history_with(None, Some("work"));
        assert_eq!(
            replay(&history, LaunchProviderSelection::Inherit, None, None),
            (None, Some("work".into()))
        );
    }

    #[test]
    fn caller_choices_are_never_overridden_by_history() {
        let history = history_with(Some("provider-a"), Some("work"));
        // 点了名账号
        assert_eq!(
            replay(
                &history,
                LaunchProviderSelection::Inherit,
                None,
                Some("personal")
            ),
            (None, Some("personal".into()))
        );
        // 换了供应商：账号 id 不能跨供应商套用
        assert_eq!(
            replay(
                &history,
                LaunchProviderSelection::Explicit,
                Some("provider-b"),
                None
            ),
            (Some("provider-b".into()), None)
        );
        // 原生启动
        assert_eq!(
            replay(&history, LaunchProviderSelection::None, None, None),
            (None, None)
        );
    }

    #[test]
    fn rows_without_a_recorded_account_and_unknown_sessions_leave_the_request_alone() {
        let legacy = history_with(Some("provider-a"), None);
        assert_eq!(
            replay(&legacy, LaunchProviderSelection::Inherit, None, None),
            (None, None)
        );

        let history = history_with(Some("provider-a"), Some("work"));
        let (mut provider_id, mut account_id) = (None, None);
        replay_recorded_account(
            &history,
            Some("someone-elses-conversation"),
            LaunchProviderSelection::Inherit,
            &mut provider_id,
            &mut account_id,
        );
        assert_eq!((provider_id, account_id), (None, None));
    }
}
