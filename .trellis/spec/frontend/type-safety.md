# Type Safety (CC-Panes)

> TypeScript 类型安全与 Rust-TS 对齐

---

## Rust-TS Type Mapping

| Rust Type | TypeScript Type | Notes |
|-----------|----------------|-------|
| `String` | `string` | |
| `i32`, `i64` | `number` | JS 精度限制注意 |
| `bool` | `boolean` | |
| `Option<T>` | `T \| null` | serde 序列化为 null |
| `Vec<T>` | `T[]` | |
| `HashMap<K,V>` | `Record<K,V>` | |
| `chrono::DateTime` | `string` | ISO 8601 格式 |
| `uuid::Uuid` | `string` | |
| enum (unit) | `string` union | `'active' \| 'archived'` |
| enum (data) | discriminated union | 带 tag 字段 |

---

## Naming Convention Alignment

Rust 使用 `snake_case`，TypeScript 使用 `camelCase`。通过 serde 转换：

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub workspace_id: String,  // → workspaceId in TS
    pub created_at: String,    // → createdAt in TS
}
```

```typescript
interface Project {
  id: string;
  workspaceId: string;
  createdAt: string;
}
```

---

## Type Definition Location

| Layer | Path | Format |
|-------|------|--------|
| Rust Models | `src-tauri/src/models/*.rs` | `#[derive(Serialize)]` structs |
| TS Types | `src/types/index.ts` | `interface` + `export` |
| TS Service | `src/services/*.ts` | invoke 泛型参数 |

---

## Checklist

修改类型定义时：
- [ ] Rust struct 和 TS interface 字段对齐
- [ ] `serde(rename_all = "camelCase")` 已添加
- [ ] `Option<T>` 对应 `T | null`（不是 `T | undefined`）
- [ ] enum 变体名称两端一致
- [ ] invoke 调用的泛型参数已更新

---

## Forbidden

- 不要在 TS 端使用 `as` 强制转型来"修复"类型不匹配
- 不要在 Rust 端使用 `serde(skip)` 来隐藏字段差异
- 不要手动在 TS 端做 snake_case → camelCase 转换（serde 处理）
