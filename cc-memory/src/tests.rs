use crate::db::MemoryDatabase;
use crate::models::*;
use crate::report::ReportGenerator;
use crate::repository::MemoryRepository;
use crate::service::MemoryService;

fn create_test_service() -> MemoryService {
    let db = MemoryDatabase::new_memory().expect("创建内存数据库失败");
    let repo = MemoryRepository::new(db);
    MemoryService::new(repo)
}

fn create_test_repo() -> MemoryRepository {
    let db = MemoryDatabase::new_memory().expect("创建内存数据库失败");
    MemoryRepository::new(db)
}

#[test]
fn test_store_and_get() {
    let svc = create_test_service();
    let mem = svc
        .store(StoreMemoryRequest {
            title: "Test Title".to_string(),
            content: "Test content, this is a memory".to_string(),
            scope: Some(MemoryScope::Global),
            category: Some(MemoryCategory::Fact),
            importance: Some(3),
            workspace_name: None,
            project_path: None,
            session_id: None,
            tags: Some(vec!["test".to_string(), "rust".to_string()]),
            source: None,
        })
        .expect("存储失败");

    assert!(!mem.id.is_empty());
    assert_eq!(mem.title, "Test Title");
    assert_eq!(mem.importance, 3);

    let found = svc.get(&mem.id).expect("查询失败").expect("未找到");
    assert_eq!(found.id, mem.id);
    assert_eq!(found.access_count, 0); // get 返回 touch 前的快照

    // 再次 get，此时 access_count 应该为 1（上一次 get 触发了 touch）
    let found2 = svc.get(&mem.id).expect("查询失败").expect("未找到");
    assert_eq!(found2.access_count, 1);
}

#[test]
fn test_store_validation() {
    let svc = create_test_service();

    // 空标题
    let result = svc.store(StoreMemoryRequest {
        title: "".to_string(),
        content: "content".to_string(),
        ..Default::default()
    });
    assert!(result.is_err());

    // 标题过长
    let result = svc.store(StoreMemoryRequest {
        title: "a".repeat(201),
        content: "content".to_string(),
        ..Default::default()
    });
    assert!(result.is_err());

    // Project scope 缺少 project_path
    let result = svc.store(StoreMemoryRequest {
        title: "title".to_string(),
        content: "content".to_string(),
        scope: Some(MemoryScope::Project),
        project_path: None,
        ..Default::default()
    });
    assert!(result.is_err());
}

#[test]
fn test_fts5_search() {
    let svc = create_test_service();

    svc.store(StoreMemoryRequest {
        title: "Tauri IPC Pattern".to_string(),
        content: "Command Service Repository three-layer architecture".to_string(),
        scope: Some(MemoryScope::Global),
        category: Some(MemoryCategory::Pattern),
        importance: Some(5),
        tags: Some(vec!["tauri".to_string(), "architecture".to_string()]),
        ..Default::default()
    })
    .unwrap();

    svc.store(StoreMemoryRequest {
        title: "Zustand State Management".to_string(),
        content: "Use Immer for immutable state updates".to_string(),
        scope: Some(MemoryScope::Global),
        category: Some(MemoryCategory::Pattern),
        importance: Some(4),
        tags: Some(vec!["zustand".to_string(), "react".to_string()]),
        ..Default::default()
    })
    .unwrap();

    // 搜索 "Tauri"
    let result = svc
        .search(MemoryQuery {
            search: Some("Tauri".to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.items[0].title, "Tauri IPC Pattern");

    // 搜索 "architecture"
    let result = svc
        .search(MemoryQuery {
            search: Some("architecture".to_string()),
            ..Default::default()
        })
        .unwrap();
    assert!(result.total >= 1);
}

#[test]
fn test_search_with_filters() {
    let svc = create_test_service();

    svc.store(StoreMemoryRequest {
        title: "Important Decision".to_string(),
        content: "Choose SQLite as storage".to_string(),
        scope: Some(MemoryScope::Global),
        category: Some(MemoryCategory::Decision),
        importance: Some(5),
        ..Default::default()
    })
    .unwrap();

    svc.store(StoreMemoryRequest {
        title: "Normal Fact".to_string(),
        content: "Project uses Rust and TypeScript".to_string(),
        scope: Some(MemoryScope::Global),
        category: Some(MemoryCategory::Fact),
        importance: Some(2),
        ..Default::default()
    })
    .unwrap();

    // 按 importance 过滤
    let result = svc
        .search(MemoryQuery {
            min_importance: Some(4),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.items[0].title, "Important Decision");

    // 按 category 过滤
    let result = svc
        .search(MemoryQuery {
            category: Some(MemoryCategory::Decision),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
}

#[test]
fn test_update() {
    let svc = create_test_service();

    let mem = svc
        .store(StoreMemoryRequest {
            title: "Original Title".to_string(),
            content: "Original content".to_string(),
            scope: Some(MemoryScope::Global),
            ..Default::default()
        })
        .unwrap();

    let updated = svc
        .update(
            &mem.id,
            UpdateMemoryRequest {
                title: Some("New Title".to_string()),
                importance: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(updated);

    let found = svc.get(&mem.id).unwrap().unwrap();
    assert_eq!(found.title, "New Title");
    assert_eq!(found.importance, 5);
}

#[test]
fn test_delete() {
    let svc = create_test_service();

    let mem = svc
        .store(StoreMemoryRequest {
            title: "To Be Deleted".to_string(),
            content: "content".to_string(),
            scope: Some(MemoryScope::Global),
            ..Default::default()
        })
        .unwrap();

    let deleted = svc.delete(&mem.id).unwrap();
    assert!(deleted);

    // 软删除后查不到
    let found = svc.get(&mem.id).unwrap();
    assert!(found.is_none());
}

#[test]
fn test_stats() {
    let svc = create_test_service();

    svc.store(StoreMemoryRequest {
        title: "Global Memory".to_string(),
        content: "content".to_string(),
        scope: Some(MemoryScope::Global),
        category: Some(MemoryCategory::Fact),
        ..Default::default()
    })
    .unwrap();

    svc.store(StoreMemoryRequest {
        title: "Project Memory".to_string(),
        content: "content".to_string(),
        scope: Some(MemoryScope::Project),
        category: Some(MemoryCategory::Decision),
        project_path: Some("/test/project".to_string()),
        ..Default::default()
    })
    .unwrap();

    let stats = svc.stats(None, None).unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.by_scope.get("global"), Some(&1));
    assert_eq!(stats.by_scope.get("project"), Some(&1));
}

#[test]
fn test_format_for_injection() {
    let svc = create_test_service();

    let m1 = svc
        .store(StoreMemoryRequest {
            title: "Architecture Decision".to_string(),
            content: "Use three-layer architecture".to_string(),
            scope: Some(MemoryScope::Global),
            category: Some(MemoryCategory::Decision),
            ..Default::default()
        })
        .unwrap();

    let m2 = svc
        .store(StoreMemoryRequest {
            title: "Coding Pattern".to_string(),
            content: "Immutable data first".to_string(),
            scope: Some(MemoryScope::Global),
            category: Some(MemoryCategory::Pattern),
            ..Default::default()
        })
        .unwrap();

    let md = svc.format_for_injection(&[m1.id, m2.id]).unwrap();
    assert!(md.contains("# Memory Context"));
    assert!(md.contains("Architecture Decision"));
    assert!(md.contains("Coding Pattern"));
}

#[test]
fn test_daily_report() {
    let repo = create_test_repo();

    let now = chrono::Utc::now();
    let today = now.format("%Y-%m-%d").to_string();

    // 手动创建带今天日期的 memory
    let mem = Memory {
        id: uuid::Uuid::new_v4().to_string(),
        title: "Today's Decision".to_string(),
        content: "Chose FTS5".to_string(),
        scope: MemoryScope::Global,
        category: MemoryCategory::Decision,
        importance: 4,
        workspace_name: None,
        project_path: None,
        session_id: None,
        tags: vec![],
        source: "user".to_string(),
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
        accessed_at: now.to_rfc3339(),
        access_count: 0,
        user_id: None,
        sync_status: "local_only".to_string(),
        sync_version: 0,
        is_deleted: false,
    };
    repo.store(&mem).unwrap();

    let report_gen = ReportGenerator::new(&repo);
    let report = report_gen
        .daily_report(&DailyReportQuery {
            date: today,
            workspace_name: None,
            project_path: None,
        })
        .unwrap();

    assert_eq!(report.total_count, 1);
    assert!(!report.entries.is_empty());

    let md = report_gen.format_daily_report_markdown(&report);
    assert!(md.contains("Today's Decision"));
}

#[test]
fn test_scope_filter() {
    let svc = create_test_service();

    svc.store(StoreMemoryRequest {
        title: "Global".to_string(),
        content: "g".to_string(),
        scope: Some(MemoryScope::Global),
        ..Default::default()
    })
    .unwrap();

    svc.store(StoreMemoryRequest {
        title: "Workspace".to_string(),
        content: "w".to_string(),
        scope: Some(MemoryScope::Workspace),
        workspace_name: Some("my-ws".to_string()),
        ..Default::default()
    })
    .unwrap();

    let result = svc
        .search(MemoryQuery {
            scope: Some(MemoryScope::Global),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.items[0].title, "Global");
}

#[test]
fn test_time_range_filter() {
    let svc = create_test_service();

    // 存储一条 Memory（created_at 是当前时间）
    svc.store(StoreMemoryRequest {
        title: "Current".to_string(),
        content: "now".to_string(),
        scope: Some(MemoryScope::Global),
        ..Default::default()
    })
    .unwrap();

    // 搜索未来时间范围 -> 空
    let result = svc
        .search(MemoryQuery {
            from_date: Some("2099-01-01T00:00:00+00:00".to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 0);

    // 搜索过去到现在 -> 有
    let result = svc
        .search(MemoryQuery {
            from_date: Some("2020-01-01T00:00:00+00:00".to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
}
