//! Skills 管理端 · 链接启停相关命令
//! （中央仓库 + 多 Agent Junction/Symlink 启停、工作空间、远程更新）
use crate::services::{SkillLinkService, SkillRemoteUpdateService};
use crate::utils::AppResult;
use cc_panes_core::models::link_skill::{
    AddWorkspaceOutcome, DisableCounts, EnableCounts, LinkSnapshot, UpdateOutcome,
};
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 全量扫描快照（rows 含每个 Agent 的 linked/copied/none 状态）
#[tauri::command]
pub fn link_snapshot(
    ws: Option<String>,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<LinkSnapshot> {
    service.snapshot(ws.as_deref())
}

/// 批量启用（agent = "*" 表示全部 Agent；overwrite = 覆盖真实副本）
#[tauri::command]
pub fn link_enable(
    skills: Vec<String>,
    agent: String,
    ws: Option<String>,
    overwrite: Option<bool>,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<EnableCounts> {
    debug!(skills = ?skills, agent = %agent, overwrite = overwrite, "cmd::link_enable");
    service.enable(&skills, &agent, ws.as_deref(), overwrite.unwrap_or(false))
}

/// 批量禁用（真实目录返回 protected，绝不自动删除）
#[tauri::command]
pub fn link_disable(
    skills: Vec<String>,
    agent: String,
    ws: Option<String>,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<DisableCounts> {
    debug!(skills = ?skills, agent = %agent, "cmd::link_disable");
    service.disable(&skills, &agent, ws.as_deref())
}

/// 批量远程更新：从各技能的 GitHub 来源仓库拉取最新版替换 master 原件
#[tauri::command]
pub async fn link_update(
    skills: Vec<String>,
    ws: Option<String>,
    link_service: State<'_, Arc<SkillLinkService>>,
    update_service: State<'_, Arc<SkillRemoteUpdateService>>,
) -> AppResult<Vec<UpdateOutcome>> {
    debug!(skills = ?skills, "cmd::link_update");
    let snapshot = link_service.snapshot(ws.as_deref())?;
    let master_dir = Path::new(&snapshot.master_dir).to_path_buf();
    let mut outcomes = Vec::new();
    for dir in skills {
        let url = snapshot
            .rows
            .iter()
            .find(|row| row.dir == dir)
            .and_then(|row| row.url.clone());
        match url {
            None => outcomes.push(UpdateOutcome {
                dir,
                status: "no-source".into(),
                detail: Some("没有远程来源（手工安装的技能）".into()),
            }),
            Some(url) => outcomes.push(update_service.update_skill(&master_dir, &dir, &url).await),
        }
    }
    Ok(outcomes)
}

/// 切换活动工作空间
#[tauri::command]
pub fn link_set_workspace(
    name: String,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<()> {
    debug!(name = %name, "cmd::link_set_workspace");
    service.set_active_workspace(&name)
}

/// 添加项目工作空间
#[tauri::command]
pub fn link_add_workspace(
    path: String,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<AddWorkspaceOutcome> {
    debug!(path = %path, "cmd::link_add_workspace");
    service.add_workspace(&path)
}

/// 手动标注仓库分组（repo 为空 = 清除）
#[tauri::command]
pub fn link_annotate_repo(
    dir: String,
    repo: String,
    service: State<'_, Arc<SkillLinkService>>,
) -> AppResult<()> {
    service.annotate_repo(&dir, &repo)
}
