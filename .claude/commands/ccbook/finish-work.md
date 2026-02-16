# 完成工作 - 提交前检查清单

在提交代码前，使用此清单确保工作完整性。

**时机**: 代码编写并测试完成后，提交前

---

## 检查清单

### 1. 代码质量

```bash
# 前端
npx tsc --noEmit
npm run test:run

# 后端
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

- [ ] TypeScript 类型检查通过？
- [ ] 前端测试通过？
- [ ] Rust 编译通过？
- [ ] Clippy 无警告？
- [ ] Rust 测试通过？
- [ ] 无遗留的 `console.log`？
- [ ] 无 `any` 类型？

### 2. 文档同步

- [ ] `.trellis/spec/backend/` 需要更新？（新模式、新模块）
- [ ] `.trellis/spec/frontend/` 需要更新？（新组件、新 Hook）
- [ ] `.trellis/spec/tauri/` 需要更新？（新 IPC 接口）
- [ ] `CLAUDE.md` 需要更新？（新功能、新命令）

### 3. Tauri 桥接变更

如果修改了 IPC 接口：

- [ ] Rust Command 参数和返回值正确？
- [ ] TS invoke 调用参数匹配？
- [ ] 类型定义（Rust struct ↔ TS interface）同步？
- [ ] `lib.rs` 的 `invoke_handler` 已注册新命令？

### 4. 数据库变更

如果修改了数据库 schema：

- [ ] `db.rs` 的 `init_tables` 已更新？
- [ ] 迁移兼容？（旧表 ALTER 不报错）
- [ ] 相关查询已更新？

### 5. 跨层验证

如果变更跨多层：

- [ ] 数据在各层正确流转？
- [ ] 错误在各边界正确处理？
- [ ] 类型在各层一致？

---

## 核心原则

> **交付不仅是代码，还包括文档、验证和知识沉淀。**

完整工作 = 代码 + 文档 + 测试 + 验证
