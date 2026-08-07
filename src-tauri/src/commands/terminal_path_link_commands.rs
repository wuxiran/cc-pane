use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

// 显式用 `_for_desktop` 变体：它比 web 路由用的 resolve_terminal_path_link 多放行
// 「显式绝对路径 + 目录」的项目外目标（core 侧 ExplicitAbsoluteDirectory scope）。
// 不做别名——放宽了安全边界的选择必须在调用点可见。
use crate::services::{
    resolve_terminal_path_link_for_desktop, ResolvedTerminalPathLink, TerminalBackend,
    TerminalBackendState, TerminalLinkContext, TerminalPathKind,
};
use crate::utils::error::AppError;
use crate::utils::AppResult;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPathDesktopAction {
    OpenDefault,
    Reveal,
}

fn resolve_authorized_path(
    backend: &dyn TerminalBackend,
    session_id: &str,
    raw_path: &str,
) -> AppResult<ResolvedTerminalPathLink> {
    resolve_authorized_context(backend.terminal_link_context(session_id)?, raw_path)
}

fn resolve_authorized_context(
    context: Option<TerminalLinkContext>,
    raw_path: &str,
) -> AppResult<ResolvedTerminalPathLink> {
    let context = context.ok_or_else(|| {
        AppError::coded(
            "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
            "The terminal path context is unavailable",
        )
    })?;
    resolve_terminal_path_link_for_desktop(&context, raw_path)
}

fn validate_desktop_action(
    kind: TerminalPathKind,
    action: TerminalPathDesktopAction,
) -> AppResult<()> {
    if matches!(action, TerminalPathDesktopAction::OpenDefault) && kind != TerminalPathKind::File {
        return Err(AppError::coded(
            "TERMINAL_PATH_ACTION_UNSUPPORTED",
            "Default application actions require a file",
        ));
    }
    Ok(())
}

fn resolve_authorized_action_context(
    context: Option<TerminalLinkContext>,
    raw_path: &str,
    action: TerminalPathDesktopAction,
) -> AppResult<ResolvedTerminalPathLink> {
    let resolved = resolve_authorized_context(context, raw_path)?;
    validate_desktop_action(resolved.kind, action)?;
    Ok(resolved)
}

fn resolve_authorized_action(
    backend: &dyn TerminalBackend,
    session_id: &str,
    raw_path: &str,
    action: TerminalPathDesktopAction,
) -> AppResult<ResolvedTerminalPathLink> {
    resolve_authorized_action_context(backend.terminal_link_context(session_id)?, raw_path, action)
}

fn map_desktop_action_result<E>(result: Result<(), E>) -> AppResult<()> {
    result.map_err(|_| {
        AppError::coded(
            "TERMINAL_PATH_ACTION_FAILED",
            "The desktop path action failed",
        )
    })
}

#[tauri::command]
pub async fn resolve_terminal_path_link(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    raw_path: String,
) -> AppResult<ResolvedTerminalPathLink> {
    let backend = service.backend();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_authorized_path(backend.as_ref(), &session_id, &raw_path)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn run_terminal_path_link_action(
    app: AppHandle,
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    raw_path: String,
    action: TerminalPathDesktopAction,
) -> AppResult<()> {
    let backend = service.backend();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved =
            resolve_authorized_action(backend.as_ref(), &session_id, &raw_path, action)?;
        let opener = app.opener();

        map_desktop_action_result(match action {
            TerminalPathDesktopAction::OpenDefault if resolved.kind == TerminalPathKind::File => {
                opener.open_path(resolved.canonical_path.clone(), None::<&str>)
            }
            TerminalPathDesktopAction::OpenDefault => unreachable!("validated above"),
            TerminalPathDesktopAction::Reveal if resolved.kind == TerminalPathKind::File => {
                opener.reveal_item_in_dir(&resolved.canonical_path)
            }
            TerminalPathDesktopAction::Reveal => {
                opener.open_path(resolved.canonical_path.clone(), None::<&str>)
            }
        })?;

        tracing::info!(action = ?action, runtime = %resolved.runtime_kind, "terminal path action completed");
        Ok(())
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(root: &std::path::Path) -> TerminalLinkContext {
        TerminalLinkContext {
            project_path: root.to_string_lossy().to_string(),
            runtime_kind: "local".to_string(),
        }
    }

    #[test]
    fn terminal_path_link_commands_fail_closed_without_context() {
        let error = resolve_authorized_context(None, "src/main.rs").expect_err("missing context");
        assert_eq!(error.code(), Some("TERMINAL_PATH_CONTEXT_UNAVAILABLE"));
    }

    #[test]
    fn terminal_path_link_commands_reject_default_open_for_directories() {
        let error = validate_desktop_action(
            TerminalPathKind::Directory,
            TerminalPathDesktopAction::OpenDefault,
        )
        .expect_err("directory default action");
        assert_eq!(error.code(), Some("TERMINAL_PATH_ACTION_UNSUPPORTED"));
        assert!(validate_desktop_action(
            TerminalPathKind::Directory,
            TerminalPathDesktopAction::Reveal,
        )
        .is_ok());
    }

    #[test]
    fn terminal_path_link_commands_resolve_explicit_external_directories() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("project");
        let outside_dir = parent.path().join("outside-dir");
        std::fs::create_dir_all(&root).expect("project root");
        std::fs::create_dir_all(&outside_dir).expect("outside directory");

        let resolved =
            resolve_authorized_context(Some(context(&root)), &outside_dir.to_string_lossy())
                .expect("desktop command should resolve the directory for confirmation");

        assert_eq!(resolved.kind, TerminalPathKind::Directory);
        // 越界必须显式带信号——前端确认框据此出差异化警示
        assert!(resolved.outside_project_root);
    }

    #[test]
    fn terminal_path_link_commands_mark_inside_paths_as_not_outside() {
        let root = tempfile::tempdir().expect("project root");
        let inside = root.path().join("src");
        std::fs::create_dir_all(&inside).expect("inside directory");

        let resolved = resolve_authorized_context(Some(context(root.path())), "src")
            .expect("inside directory resolves");

        assert_eq!(resolved.kind, TerminalPathKind::Directory);
        assert!(!resolved.outside_project_root);
    }

    #[test]
    fn terminal_path_link_action_reauthorizes_after_target_changes() {
        let root = tempfile::tempdir().expect("project root");
        let target = root.path().join("target.txt");
        std::fs::write(&target, "before").expect("target file");
        let trusted = context(root.path());

        resolve_authorized_action_context(
            Some(trusted.clone()),
            "target.txt",
            TerminalPathDesktopAction::OpenDefault,
        )
        .expect("initial action authorization");
        std::fs::remove_file(&target).expect("remove target");
        let deleted = resolve_authorized_action_context(
            Some(trusted.clone()),
            "target.txt",
            TerminalPathDesktopAction::OpenDefault,
        )
        .expect_err("deleted target must fail closed");
        assert_eq!(deleted.code(), Some("TERMINAL_PATH_UNAVAILABLE"));

        std::fs::create_dir(&target).expect("replace file with directory");
        let changed_kind = resolve_authorized_action_context(
            Some(trusted),
            "target.txt",
            TerminalPathDesktopAction::OpenDefault,
        )
        .expect_err("changed target kind must be revalidated");
        assert_eq!(
            changed_kind.code(),
            Some("TERMINAL_PATH_ACTION_UNSUPPORTED")
        );
    }

    #[test]
    fn terminal_path_link_action_fails_when_session_closed() {
        let error = resolve_authorized_action_context(
            None,
            "src/main.rs",
            TerminalPathDesktopAction::Reveal,
        )
        .expect_err("closed session must fail closed");
        assert_eq!(error.code(), Some("TERMINAL_PATH_CONTEXT_UNAVAILABLE"));
    }

    #[test]
    fn terminal_path_link_action_maps_opener_failures_without_paths() {
        let error = map_desktop_action_result::<&str>(Err("C:\\private\\secret.txt"))
            .expect_err("opener failure");
        assert_eq!(error.code(), Some("TERMINAL_PATH_ACTION_FAILED"));
        assert!(!error.message().contains("private"));
    }
}
