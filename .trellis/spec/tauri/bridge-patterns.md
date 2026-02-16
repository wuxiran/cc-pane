# Rust-TS Bridge Patterns (CC-Panes)

> 跨语言数据传输模式

---

## Data Flow

```
TS (camelCase) → invoke() → Tauri IPC → serde deserialize → Rust (snake_case)
                                                             ↓
TS (camelCase) ← Promise   ← Tauri IPC ← serde serialize  ← Rust (snake_case)
```

serde 的 `rename_all = "camelCase"` 自动处理命名转换。

---

## Pattern 1: Simple CRUD

```rust
// Rust Model
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub workspace_id: String,
    pub created_at: String,
}

// Rust Command
#[tauri::command]
async fn get_project(id: String, service: State<'_, Arc<ProjectService>>) -> Result<Project, String> {
    service.get_by_id(&id).map_err(|e| e.to_string())
}
```

```typescript
// TS Type (must match Rust struct)
interface Project {
  id: string;
  name: string;
  workspaceId: string;
  createdAt: string;
}

// TS Service
async function getProject(id: string): Promise<Project> {
  return invoke<Project>('get_project', { id });
}
```

---

## Pattern 2: Optional Fields

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProject {
    pub name: Option<String>,
    pub alias: Option<String>,
}
```

```typescript
interface UpdateProject {
  name: string | null;    // Option<T> → T | null
  alias: string | null;
}
```

---

## Pattern 3: Enum Variants

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}
```

```typescript
type SplitDirection = 'horizontal' | 'vertical';
```

---

## Pattern 4: Complex Return Types

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub changed_files: Vec<ChangedFile>,
    pub is_clean: bool,
}
```

```typescript
interface GitStatus {
  branch: string;
  changedFiles: ChangedFile[];
  isClean: boolean;
}
```

---

## Checklist for Bridge Changes

添加/修改桥接代码时：

- [ ] Rust struct 有 `#[serde(rename_all = "camelCase")]`
- [ ] TS interface 字段与 Rust 一一对应
- [ ] `Option<T>` 在 TS 中是 `T | null`（不是 `undefined`）
- [ ] enum 变体名称匹配（camelCase）
- [ ] Command 已在 `lib.rs` 注册
- [ ] Service 函数的 invoke 命令名与 Rust 函数名一致
- [ ] 运行 `/ccbook:check-tauri-bridge` 验证
