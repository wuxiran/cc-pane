//! 项目管理全生命周期集成测试

mod common;

use cc_panes_lib::services::ProjectService;

/// 创建一个完整的 ProjectService 实例用于集成测试
fn setup_service() -> (ProjectService, std::path::PathBuf) {
    let (_, repo) = common::test_db::create_test_db();
    let service = ProjectService::new(repo);

    let temp_dir =
        std::env::temp_dir().join(format!("cc-panes-integration-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).expect("创建临时目录失败");

    (service, temp_dir)
}

fn cleanup(temp_dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(temp_dir);
}

#[test]
fn test_full_lifecycle() {
    let (service, temp_dir) = setup_service();

    // 1. 初始列表为空
    let projects = service.list_projects().unwrap();
    assert!(projects.is_empty());

    // 2. 创建项目目录
    let project_dir = temp_dir.join("my-project");
    std::fs::create_dir_all(&project_dir).unwrap();

    // 3. 添加项目
    let project = service.add_project(project_dir.to_str().unwrap()).unwrap();
    assert_eq!(project.name, "my-project");
    assert!(!project.id.is_empty());

    // 4. 查询项目
    let found = service.get_project(&project.id).unwrap().unwrap();
    assert_eq!(found.id, project.id);
    assert_eq!(found.path, project.path);

    // 5. 更新名称
    service
        .update_project_name(&project.id, "重命名项目")
        .unwrap();
    let found = service.get_project(&project.id).unwrap().unwrap();
    assert_eq!(found.name, "重命名项目");

    // 6. 设置别名
    service
        .update_project_alias(&project.id, Some("别名"))
        .unwrap();
    let found = service.get_project(&project.id).unwrap().unwrap();
    assert_eq!(found.alias, Some("别名".to_string()));

    // 7. 清除别名
    service.update_project_alias(&project.id, None).unwrap();
    let found = service.get_project(&project.id).unwrap().unwrap();
    assert!(found.alias.is_none());

    // 8. 列表应有 1 个项目
    let projects = service.list_projects().unwrap();
    assert_eq!(projects.len(), 1);

    // 9. 删除项目
    service.remove_project(&project.id).unwrap();

    // 10. 列表恢复为空
    let projects = service.list_projects().unwrap();
    assert!(projects.is_empty());

    cleanup(&temp_dir);
}

#[test]
fn test_multiple_projects() {
    let (service, temp_dir) = setup_service();

    // 创建多个项目
    let dirs: Vec<_> = (0..5)
        .map(|i| {
            let dir = temp_dir.join(format!("project-{}", i));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        })
        .collect();

    for dir in &dirs {
        service.add_project(dir.to_str().unwrap()).unwrap();
    }

    let projects = service.list_projects().unwrap();
    assert_eq!(projects.len(), 5);

    // 删除中间的项目
    service.remove_project(&projects[2].id).unwrap();

    let projects = service.list_projects().unwrap();
    assert_eq!(projects.len(), 4);

    cleanup(&temp_dir);
}

#[test]
fn test_error_handling() {
    let (service, temp_dir) = setup_service();

    // 添加不存在的路径
    assert!(service.add_project("/nonexistent/path/project").is_err());

    // 删除不存在的项目
    assert!(service.remove_project("invalid-id").is_err());

    // 更新不存在项目的名称
    assert!(service.update_project_name("invalid-id", "name").is_err());

    // 更新不存在项目的别名
    assert!(service
        .update_project_alias("invalid-id", Some("alias"))
        .is_err());

    // 空名称更新
    let project_dir = temp_dir.join("error-test");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = service.add_project(project_dir.to_str().unwrap()).unwrap();
    assert!(service.update_project_name(&project.id, "").is_err());

    cleanup(&temp_dir);
}
