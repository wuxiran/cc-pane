//! 工作空间管理全生命周期集成测试
//!
//! 测试 WorkspaceService 与文件系统 (workspace.json) 的端到端流程

use cc_panes_lib::services::WorkspaceService;

/// 创建临时目录和 WorkspaceService 实例
fn setup() -> (tempfile::TempDir, WorkspaceService) {
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let service = WorkspaceService::new(dir.path().to_path_buf());
    (dir, service)
}

// ============ 1. 完整 CRUD 流程 ============

#[test]
fn test_crud_full_lifecycle() {
    let (_dir, service) = setup();

    // 1. 初始列表为空
    let list = service.list_workspaces().unwrap();
    assert!(list.is_empty());

    // 2. 创建工作空间
    let ws = service.create_workspace("my-workspace", None).unwrap();
    assert_eq!(ws.name, "my-workspace");
    assert!(!ws.id.is_empty());
    assert!(ws.projects.is_empty());
    assert!(!ws.pinned);
    assert!(!ws.hidden);

    // 3. 列表应有 1 个
    let list = service.list_workspaces().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "my-workspace");

    // 4. 获取工作空间
    let fetched = service.get_workspace("my-workspace").unwrap();
    assert_eq!(fetched.id, ws.id);
    assert_eq!(fetched.name, ws.name);

    // 5. 重命名
    service
        .rename_workspace("my-workspace", "renamed-ws")
        .unwrap();
    let renamed = service.get_workspace("renamed-ws").unwrap();
    assert_eq!(renamed.name, "renamed-ws");
    assert_eq!(renamed.id, ws.id);
    assert!(service.get_workspace("my-workspace").is_err());

    // 6. 删除
    service.delete_workspace("renamed-ws").unwrap();
    let list = service.list_workspaces().unwrap();
    assert!(list.is_empty());
}

// ============ 2. 项目关联流程 ============

#[test]
fn test_project_association_flow() {
    let (_dir, service) = setup();

    // 创建工作空间
    service.create_workspace("ws-projects", None).unwrap();

    // 添加项目
    let p1 = service
        .add_project("ws-projects", "/path/to/project-a")
        .unwrap();
    assert!(!p1.id.is_empty());
    assert_eq!(p1.path, "/path/to/project-a");
    assert!(p1.alias.is_none());

    let p2 = service
        .add_project("ws-projects", "/path/to/project-b")
        .unwrap();

    // 列出项目（通过 get_workspace）
    let ws = service.get_workspace("ws-projects").unwrap();
    assert_eq!(ws.projects.len(), 2);
    let paths: Vec<&str> = ws.projects.iter().map(|p| p.path.as_str()).collect();
    assert!(paths.contains(&"/path/to/project-a"));
    assert!(paths.contains(&"/path/to/project-b"));

    // 移除项目
    service.remove_project("ws-projects", &p1.id).unwrap();
    let ws = service.get_workspace("ws-projects").unwrap();
    assert_eq!(ws.projects.len(), 1);
    assert_eq!(ws.projects[0].id, p2.id);

    // 不能重复添加
    let dup_result = service.add_project("ws-projects", "/path/to/project-b");
    assert!(dup_result.is_err());
    assert!(dup_result.unwrap_err().contains("PROJECT_ALREADY_EXISTS"));
}

// ============ 3. Provider 绑定 ============

#[test]
fn test_provider_binding() {
    let (_dir, service) = setup();

    service.create_workspace("ws-provider", None).unwrap();

    // 初始无 Provider
    let ws = service.get_workspace("ws-provider").unwrap();
    assert!(ws.provider_id.is_none());

    // 绑定 Provider
    service
        .update_workspace_provider("ws-provider", Some("provider-abc"))
        .unwrap();
    let ws = service.get_workspace("ws-provider").unwrap();
    assert_eq!(ws.provider_id, Some("provider-abc".to_string()));

    // 解绑 Provider
    service
        .update_workspace_provider("ws-provider", None)
        .unwrap();
    let ws = service.get_workspace("ws-provider").unwrap();
    assert!(ws.provider_id.is_none());
}

// ============ 4. 持久化验证 ============

#[test]
fn test_persistence_across_service_instances() {
    let dir = tempfile::tempdir().expect("创建临时目录失败");

    // 第一个 service 实例：创建数据
    {
        let service = WorkspaceService::new(dir.path().to_path_buf());
        service.create_workspace("persist-test", None).unwrap();
        service
            .add_project("persist-test", "/path/project")
            .unwrap();
        service
            .update_workspace_alias("persist-test", Some("my-alias"))
            .unwrap();
        service
            .update_workspace_provider("persist-test", Some("provider-1"))
            .unwrap();
        service
            .update_workspace_pinned("persist-test", true)
            .unwrap();
    }

    // 第二个 service 实例：读取验证
    {
        let service = WorkspaceService::new(dir.path().to_path_buf());
        let ws = service.get_workspace("persist-test").unwrap();
        assert_eq!(ws.name, "persist-test");
        assert_eq!(ws.alias, Some("my-alias".to_string()));
        assert_eq!(ws.provider_id, Some("provider-1".to_string()));
        assert!(ws.pinned);
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.projects[0].path, "/path/project");
    }
}

// ============ 5. 多 workspace 排序 ============

#[test]
fn test_multiple_workspaces_sort_order() {
    let (_dir, service) = setup();

    // 创建 3 个工作空间
    service.create_workspace("ws-alpha", None).unwrap();
    service.create_workspace("ws-beta", None).unwrap();
    service.create_workspace("ws-gamma", None).unwrap();

    // 自定义排序：gamma=0, alpha=1, beta=2
    service
        .reorder_workspaces(vec![
            "ws-gamma".to_string(),
            "ws-alpha".to_string(),
            "ws-beta".to_string(),
        ])
        .unwrap();

    let list = service.list_workspaces().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].name, "ws-gamma");
    assert_eq!(list[1].name, "ws-alpha");
    assert_eq!(list[2].name, "ws-beta");

    // pinned 优先：将 beta 设为 pinned
    service.update_workspace_pinned("ws-beta", true).unwrap();
    let list = service.list_workspaces().unwrap();
    // pinned 的 beta 应排在最前面
    assert_eq!(list[0].name, "ws-beta");
}

#[test]
fn test_reorder_validation() {
    let (_dir, service) = setup();

    // 空列表不允许
    let result = service.reorder_workspaces(vec![]);
    assert!(result.is_err());

    // 重复名称不允许
    service.create_workspace("ws1", None).unwrap();
    let result = service.reorder_workspaces(vec!["ws1".to_string(), "ws1".to_string()]);
    assert!(result.is_err());

    // 不存在的工作空间
    let result = service.reorder_workspaces(vec!["nonexistent".to_string()]);
    assert!(result.is_err());
}

// ============ 6. 别名 ============

#[test]
fn test_workspace_alias() {
    let (_dir, service) = setup();

    service.create_workspace("ws-alias-test", None).unwrap();

    // 初始无别名
    let ws = service.get_workspace("ws-alias-test").unwrap();
    assert!(ws.alias.is_none());

    // 设置别名
    service
        .update_workspace_alias("ws-alias-test", Some("my-ws-alias"))
        .unwrap();
    let ws = service.get_workspace("ws-alias-test").unwrap();
    assert_eq!(ws.alias, Some("my-ws-alias".to_string()));

    // 更新别名
    service
        .update_workspace_alias("ws-alias-test", Some("updated-alias"))
        .unwrap();
    let ws = service.get_workspace("ws-alias-test").unwrap();
    assert_eq!(ws.alias, Some("updated-alias".to_string()));

    // 清除别名
    service
        .update_workspace_alias("ws-alias-test", None)
        .unwrap();
    let ws = service.get_workspace("ws-alias-test").unwrap();
    assert!(ws.alias.is_none());
}

#[test]
fn test_project_alias_in_workspace() {
    let (_dir, service) = setup();

    service.create_workspace("ws-proj-alias", None).unwrap();
    let project = service
        .add_project("ws-proj-alias", "/path/proj")
        .unwrap();

    // 设置项目别名
    service
        .update_project_alias("ws-proj-alias", &project.id, Some("proj-alias"))
        .unwrap();
    let ws = service.get_workspace("ws-proj-alias").unwrap();
    assert_eq!(ws.projects[0].alias, Some("proj-alias".to_string()));

    // 清除项目别名
    service
        .update_project_alias("ws-proj-alias", &project.id, None)
        .unwrap();
    let ws = service.get_workspace("ws-proj-alias").unwrap();
    assert!(ws.projects[0].alias.is_none());
}

// ============ 7. Hidden 状态 ============

#[test]
fn test_workspace_hidden() {
    let (_dir, service) = setup();

    service.create_workspace("ws-hidden", None).unwrap();

    // 默认不隐藏
    let ws = service.get_workspace("ws-hidden").unwrap();
    assert!(!ws.hidden);

    // 设置隐藏
    service.update_workspace_hidden("ws-hidden", true).unwrap();
    let ws = service.get_workspace("ws-hidden").unwrap();
    assert!(ws.hidden);

    // 取消隐藏
    service
        .update_workspace_hidden("ws-hidden", false)
        .unwrap();
    let ws = service.get_workspace("ws-hidden").unwrap();
    assert!(!ws.hidden);
}

// ============ 8. 错误处理 ============

#[test]
fn test_error_handling() {
    let (_dir, service) = setup();

    // 获取不存在的工作空间
    assert!(service.get_workspace("nonexistent").is_err());

    // 删除不存在的工作空间
    assert!(service.delete_workspace("nonexistent").is_err());

    // 重命名不存在的工作空间
    assert!(service.rename_workspace("nonexistent", "new").is_err());

    // 创建重复名称
    service.create_workspace("dup-ws", None).unwrap();
    assert!(service.create_workspace("dup-ws", None).is_err());

    // 重命名到已存在的名称
    service.create_workspace("target-ws", None).unwrap();
    let result = service.rename_workspace("dup-ws", "target-ws");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("WORKSPACE_NAME_DUPLICATE"));

    // 移除不存在的项目
    let result = service.remove_project("dup-ws", "fake-id");
    assert!(result.is_err());

    // 更新不存在项目的别名
    let result = service.update_project_alias("dup-ws", "fake-id", Some("alias"));
    assert!(result.is_err());
}
