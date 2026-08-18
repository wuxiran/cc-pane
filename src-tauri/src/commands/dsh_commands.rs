//! DeepSeek Harness（dsh）实例的 Tauri 命令层
//!
//! 命令层负责把散在各处的注入材料**装配**成一次启动：MCP 端点来自
//! orchestrator manifest、Provider 来自 ProviderService、skills 来自已物化的
//! 托管目录、hooks 二进制来自 `ProjectCliHooksService`。`DshService` 只管
//! 「怎么起一个进程」，不认识这些来源。

use crate::utils::AppResult;
use cc_panes_core::models::dsh::{DshInstance, DshLaunchSpec};
use cc_panes_core::models::Workspace;
use cc_panes_core::services::{
    classify_path, DshService, PathStatusKind, ProjectCliHooksService, ProviderService,
    WorkspaceService,
};
use cc_panes_core::utils::{canonical_project_path, orchestrator_manifest, AppPaths};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;
use tracing::warn;

/// 组装本次启动的注入材料。
///
/// 每一项都是**可缺失**的：orchestrator 没起来就没有 MCP、没配 Provider 就没有
/// 模型路由、hook 二进制没编出来就没有 hooks。任何一项缺失都只让对应能力消失，
/// 不阻断启动——一个「少了 MCP 但能用」的标签，远好过一个打不开的标签。
fn build_spec(
    app_paths: &AppPaths,
    provider_service: &ProviderService,
    project_dir: Option<String>,
    workspace_path: Option<String>,
) -> DshLaunchSpec {
    let mut spec = DshLaunchSpec {
        project_dir,
        workspace_path,
        ..Default::default()
    };

    // MCP：URL 形状与我们写给其他 CLI 的一致（token 同时进 query 与 header，
    // 这里只有 query——dsh 的 mcp-client 支持 headers，但 URL 已足够鉴权）。
    match orchestrator_manifest::read_endpoint(app_paths.data_dir()) {
        Some((port, token)) => {
            spec.mcp_url = Some(format!("http://127.0.0.1:{port}/mcp?token={token}"));
        }
        None => warn!("orchestrator endpoint unavailable, starting dsh without ccpanes MCP"),
    }

    // Skills：已由 DefaultSkillService 物化好，这里只是指过去。
    let skills_dir = app_paths.skills_dir().join("builtin");
    if skills_dir.is_dir() {
        spec.skill_dirs
            .push(skills_dir.to_string_lossy().to_string());
    }

    DshService::apply_providers(&mut spec, &provider_service.list_providers());
    spec
}

/// 启动（或复用）该标签所属工作空间的 dsh 实例。
///
/// `workspace_path` 决定复用哪个实例：同工作空间的标签共享一个进程，于是
/// API key、工作区注册与会话历史都按工作空间共享——每标签一个实例时这三样
/// 全跟着标签走，用户每开一个新标签就要重填一次 key。
#[tauri::command]
pub async fn start_dsh_instance(
    tab_id: String,
    project_dir: Option<String>,
    workspace_path: Option<String>,
    service: State<'_, Arc<DshService>>,
    provider_service: State<'_, Arc<ProviderService>>,
    // Arc<AppPaths> 而非 AppPaths：lib.rs 管进去的就是 Arc（`.manage(app_paths)`
    // 那个变量是 `Arc::new(AppPaths::new(..))`）。类型对不上时 `cargo check`
    // 照样过——Tauri 的 State 解析在**运行时**，只有真点一次才会报
    // 「state not managed for field」。
    app_paths: State<'_, Arc<AppPaths>>,
    workspace_service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<DshInstance> {
    let mut spec = build_spec(&app_paths, &provider_service, project_dir, workspace_path);

    // hooks 走「尽力而为」：二进制找不到就不注入。真正的降级在 DshService::start
    // 里——那里还要处理「桥装不上」的情况。
    match ProjectCliHooksService::get_hook_binary_path() {
        Ok(binary) => {
            if let Err(error) = service.apply_hooks(&mut spec, &binary) {
                warn!(%error, "failed to write dsh hooks config, starting without hooks");
            }
        }
        Err(error) => warn!(%error, "hook binary unavailable, starting dsh without hooks"),
    }

    let instance = service.start(&tab_id, &spec)?;

    // 起来之后把 CC-Panes 的项目推进它的工作区列表——dsh 的输入框在选定
    // 工作区之前是禁用的（占位文案「选择一个工作区开始」），不推的话用户
    // 每开一个实例都要手动添加一遍自己早就在 CC-Panes 里维护好的项目。
    //
    // 幂等且尽力而为：`workspace.create` 对同一路径只建一条记录，失败只记日志。
    let projects = all_active_project_paths(&workspace_service);
    if !projects.is_empty() {
        let port = instance.port;
        tauri::async_runtime::spawn(async move {
            super::dsh_workspace_sync::push_workspaces(port, projects).await;
        });
    }

    Ok(instance)
}

/// **全部**工作空间下活跃（未归档）项目的路径，去重后按注册顺序返回。
///
/// 推全部而非「当前工作空间」的那一份：dsh 的工作区列表是用户在它自己 UI 里
/// 挑项目的地方，而用户的心智模型是「CC-Panes 里维护好的项目就该在这儿」。
/// 只推当前工作空间会让另外十几个项目永远要手工添加一遍。
///
/// 附带的好处是**不再依赖 `workspace_path`**：那个字段前端常常传不下来
/// （旧标签没快照、选中态取不到），一旦为 None，按工作空间过滤就退化成
/// 「一个都不推」，功能整个静默失效。推全部把这条依赖去掉了。
///
/// 三条过滤规矩：
/// - 归档项目不推：`archivedAt` 是逻辑删除标记，用户已表示不想看见，推过去
///   等于在 dsh 侧复活一遍。
/// - 路径判定必须过 `classify_path`，不能裸 `Path::exists()`：注册路径可能是
///   `/mnt/d/...` 或 `\\wsl.localhost\...` 形式，裸判会把合法路径误杀。
/// - `Unverifiable` 一律**保留**。它表示「现在看不到」而非「不存在」（SSH 项目、
///   或 WSL 发行版没运行）。判成 missing 丢掉，用户会发现自己的 WSL 项目莫名
///   其妙不见了。注意 `classify_path` 在 WSL VM 未运行时直接返回 Unverifiable，
///   不会为了探测反向唤醒 Vmmem。
fn all_active_project_paths(workspace_service: &WorkspaceService) -> Vec<String> {
    let Ok(workspaces) = workspace_service.list_workspaces() else {
        return Vec::new();
    };
    active_project_paths_of(workspaces)
}

/// `all_active_project_paths` 的纯函数内核，便于测试过滤与去重规矩。
fn active_project_paths_of(workspaces: Vec<Workspace>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let mut skipped_missing = 0usize;

    for workspace in workspaces {
        // 已归档的工作空间同样不推——与项目级 archivedAt 同一口径。
        if workspace.archived_at.is_some() {
            continue;
        }
        for project in workspace.projects {
            if project.archived_at.is_some() {
                continue;
            }
            if classify_path(&project.path, project.ssh.is_some()) == PathStatusKind::Missing {
                skipped_missing += 1;
                continue;
            }
            // 同一个仓库可能在多个工作空间里各注册一次，形态还可能不同
            // （Windows / `/mnt` / UNC）。按规范化身份去重，否则 dsh 的
            // 工作区列表里会出现看着一样的重复条目。
            let key = canonical_project_path(&project.path).to_lowercase();
            if seen.insert(key) {
                paths.push(project.path);
            }
        }
    }

    if skipped_missing > 0 {
        // 静默跳过会让用户以为「注入漏了」。路径失效多半是删了 worktree 而
        // 项目记录没回收（写入自动化、删除手动化的单向流）。
        warn!(
            skipped_missing,
            "skipped dsh workspace injection for projects whose path no longer exists"
        );
    }
    paths
}

#[tauri::command]
pub fn stop_dsh_instance(tab_id: String, service: State<'_, Arc<DshService>>) -> AppResult<bool> {
    service.stop(&tab_id).map_err(|e| e.into())
}

#[tauri::command]
pub fn list_dsh_instances(service: State<'_, Arc<DshService>>) -> AppResult<Vec<DshInstance>> {
    Ok(service.list())
}

#[tauri::command]
pub fn get_dsh_instance(
    tab_id: String,
    service: State<'_, Arc<DshService>>,
) -> AppResult<Option<DshInstance>> {
    Ok(service.get(&tab_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 serde 构造夹具而非逐字段填：Workspace 有二十来个字段且还在长，
    /// 手写结构体字面量会让每次加字段都打挂这里的测试。
    fn workspace(name: &str, archived: bool, projects: serde_json::Value) -> Workspace {
        let mut value = serde_json::json!({
            "id": name,
            "name": name,
            "createdAt": "2026-08-14T00:00:00Z",
            "projects": projects,
        });
        if archived {
            value["archivedAt"] = serde_json::json!("2026-08-14T00:00:00Z");
        }
        serde_json::from_value(value).expect("workspace fixture")
    }

    fn project(id: &str, path: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "path": path, "alias": null })
    }

    fn archived_project(id: &str, path: &str) -> serde_json::Value {
        let mut v = project(id, path);
        v["archivedAt"] = serde_json::json!("2026-08-14T00:00:00Z");
        v
    }

    /// 真实存在的目录。不能拿仓库里的相对路径充数：`cargo test` 的进程 cwd 是
    /// **包目录**（src-tauri/）而非仓库根，`classify_path` 会把它判成 Missing
    /// 然后过滤掉，测试就变成在验证「什么都收不到」。
    fn real_dir(root: &tempfile::TempDir, name: &str) -> String {
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    /// 跨**全部**工作空间收集，而不是只收当前那一个——这正是方案 2 的目的。
    /// 旧实现按 workspace_path 只 `.find()` 一个工作空间，其余项目永远推不出去。
    #[test]
    fn collects_projects_across_every_workspace() {
        let root = tempfile::tempdir().unwrap();
        let a = real_dir(&root, "alpha");
        let b = real_dir(&root, "beta");
        let paths = active_project_paths_of(vec![
            workspace("one", false, serde_json::json!([project("p1", &a)])),
            workspace("two", false, serde_json::json!([project("p2", &b)])),
        ]);
        assert_eq!(paths.len(), 2, "两个工作空间的项目都要收进来");
    }

    /// 归档的工作空间与归档的项目都不推：`archivedAt` 是逻辑删除标记，
    /// 推过去等于在 dsh 侧把用户已经收起来的东西复活一遍。
    #[test]
    fn archived_workspaces_and_projects_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let live = real_dir(&root, "live");
        let other = real_dir(&root, "other");
        let paths = active_project_paths_of(vec![
            workspace(
                "archived-ws",
                true,
                serde_json::json!([project("p1", &live)]),
            ),
            workspace(
                "live-ws",
                false,
                serde_json::json!([archived_project("p2", &other), project("p3", &live)]),
            ),
        ]);
        assert_eq!(paths, vec![live]);
    }

    /// 同一个仓库在多个工作空间各注册一次时只推一条，否则 dsh 的工作区列表里
    /// 会出现看着一模一样的重复条目。
    #[test]
    fn duplicate_registrations_collapse_to_one_entry() {
        let root = tempfile::tempdir().unwrap();
        let same = real_dir(&root, "same");
        let paths = active_project_paths_of(vec![
            workspace("one", false, serde_json::json!([project("p1", &same)])),
            workspace("two", false, serde_json::json!([project("p2", &same)])),
        ]);
        assert_eq!(paths.len(), 1);
    }

    /// 回归守卫：只丢弃**确定不存在**的路径，无法验证的必须保留。
    ///
    /// SSH 项目与「WSL 发行版没运行」都判为 Unverifiable。顺手把它们一起丢掉，
    /// 用户会发现自己的远程项目莫名其妙没被注入，且没有任何报错。
    #[test]
    fn missing_paths_are_dropped_but_unverifiable_ones_are_kept() {
        let mut ssh = project("ssh", "/remote/repo");
        ssh["ssh"] = serde_json::json!({ "host": "example", "remotePath": "/remote/repo" });

        let paths = active_project_paths_of(vec![workspace(
            "one",
            false,
            serde_json::json!([project("gone", "D:/definitely/not/here"), ssh]),
        )]);

        assert_eq!(
            paths,
            vec!["/remote/repo".to_string()],
            "确定不存在的丢弃，无法验证的保留"
        );
    }
}
