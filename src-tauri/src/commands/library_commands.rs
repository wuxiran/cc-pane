//! 资料空间（docs/108）：一键创建 = 铺模板 + 建工作空间 + 把目录登记为项目。
//! 业务逻辑都在模板的 CLAUDE.md / skills 里，由前端随后拉起的素材助手会话执行。

use crate::services::WorkspaceService;
use crate::utils::{validate_path, AppError, AppResult};
use cc_panes_core::services::library_space_service::{self, LibraryScaffold};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySpace {
    pub root: String,
    pub workspace_name: String,
    /// false = 同名工作空间已存在，本次只补模板与项目登记。
    pub created_workspace: bool,
    pub scaffold: LibraryScaffold,
}

#[tauri::command]
pub fn create_library_space(
    workspace_name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<LibrarySpace> {
    let name = workspace_name.trim();
    if name.is_empty() {
        return Err(AppError::from("Workspace name is required".to_string()));
    }
    let root = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            validate_path(p)?;
            PathBuf::from(p)
        }
        None => library_space_service::default_root()
            .ok_or_else(|| AppError::from("Cannot resolve home directory".to_string()))?,
    };
    debug!(name = %name, root = %root.display(), "cmd::create_library_space");

    // 先铺模板：create_workspace 只在缺 CLAUDE.md 时写通用模板，这样留下的是资料空间约定。
    let scaffold = library_space_service::scaffold(&root)?;
    let root_str = scaffold.root.clone();
    let created_workspace = match service.get_workspace(name) {
        Ok(_) => false,
        Err(_) => {
            service.create_workspace(name, Some(&root_str))?;
            true
        }
    };
    if let Err(error) = service.add_project(name, &root_str) {
        if !error.starts_with("PROJECT_ALREADY_EXISTS:") {
            return Err(AppError::from(error));
        }
    }
    Ok(LibrarySpace {
        root: root_str,
        workspace_name: name.to_string(),
        created_workspace,
        scaffold,
    })
}
