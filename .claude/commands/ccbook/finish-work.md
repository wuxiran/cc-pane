# 完成工作 - 提交前检查清单

> **收尾报告的必填字段见 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) §6。**
> 其中「剩余的 NEXT」最容易被省掉，省掉等于把「没做完」报成「完成」。
> 另：判定成败不要加 `| tail`，管道会掩码退出码——用 `echo "EXIT=${PIPESTATUS[0]}"` 或不加管道。

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

### 1.5 worktree 收尾（仅当本次工作在 git worktree 中进行）

- [ ] 分支已合并回主仓库（或用户明确弃置）？
- [ ] worktree 内无未提交改动，`git worktree remove` + 删分支已执行？
- [ ] 已提醒用户在 CC-Panes UI 移除对应项目节点？

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

### 6. 未尽事项落 todo（回流）

收尾前扫一遍本次会话：文档没更、测试缺口、发现但没修的坑。每项各建一条 todo（`mcp__ccpanes__create_todo`），别让临终发现随会话蒸发：

- `tags` 带 `ai-work-item`（AI 工作项标记；可加 `family:<key>` / `skill:<name>` / `cli:<claude|codex>` 路由提示）
- description 必含两行：`验收: <一句可执行的话>` 与 `来源: <planRef 或 sessionId 摘要>`
- 收尾摘要里列出新建的 todo id

无未尽事项则明说「无回流项」，不建空 todo。

---

## 核心原则

> **交付不仅是代码，还包括文档、验证和知识沉淀。**

完整工作 = 代码 + 文档 + 测试 + 验证
