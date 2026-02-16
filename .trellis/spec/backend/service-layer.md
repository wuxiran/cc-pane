# Service Layer Design (CC-Panes)

> State 注入和业务逻辑组织

---

## Service Initialization

在 `lib.rs` 中初始化服务并注入 Tauri State：

```rust
// lib.rs
pub fn run() {
    let db = Database::new(&db_path).expect("Failed to init database");
    let project_repo = ProjectRepo::new(db.clone());
    let project_service = Arc::new(ProjectService::new(project_repo));

    tauri::Builder::default()
        .manage(project_service)
        .invoke_handler(tauri::generate_handler![
            commands::project_commands::get_projects,
            commands::project_commands::create_project,
        ])
        .run(tauri::generate_context!())
        .expect("error running app");
}
```

---

## Service Pattern

```rust
pub struct ProjectService {
    repo: ProjectRepo,
}

impl ProjectService {
    pub fn new(repo: ProjectRepo) -> Self {
        Self { repo }
    }

    pub fn get_all(&self, workspace_id: &str) -> AppResult<Vec<Project>> {
        self.repo.find_by_workspace(workspace_id)
    }

    pub fn create(&self, name: &str, path: &str) -> AppResult<Project> {
        let project = Project::new(name, path);
        self.repo.insert(&project)?;
        Ok(project)
    }
}
```

---

## Command Layer Usage

```rust
#[tauri::command]
async fn get_projects(
    workspace_id: String,
    service: State<'_, Arc<ProjectService>>,
) -> Result<Vec<Project>, String> {
    service.get_all(&workspace_id).map_err(|e| e.to_string())
}
```

---

## Key Rules

1. **State 注入**: `State<'_, Arc<XxxService>>` — Arc 用于线程安全共享
2. **单一职责**: 一个 Service 管理一个领域
3. **不持有 State**: Service 不应该有可变状态（数据在 DB 中）
4. **错误转换**: Command 层负责将 `AppError` 转为 `String`

---

## Forbidden

- Service 中直接访问 Tauri app handle（通过参数传入）
- Service 中持有 `Mutex<T>` 可变状态（除了 DB 连接）
- 在 Service 中做 UI 相关逻辑（弹窗、通知）
