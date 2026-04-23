# 跨层检查

检查你的变更是否考虑了所有维度。大多数 bug 来自"没想到"而非技术能力不足。

---

## 执行步骤

### 1. 识别变更范围

```bash
git status
git diff --name-only
```

### 2. 选择适用的检查维度

---

## 维度 A: 跨层数据流（涉及 3+ 层时必检）

**CC-Panes 的层次**:

| 层 | 位置 |
|----|------|
| React 组件 | `src/components/` |
| Zustand Store | `src/stores/` |
| TS 服务 | `src/services/` |
| Tauri IPC | `invoke()` / `#[tauri::command]` |
| Rust 服务 | `src-tauri/src/services/` |
| 数据仓储 | `src-tauri/src/repository/` |
| SQLite/FS | 数据库 / 文件系统 |

**检查清单**:
- [ ] 读取流: SQLite → Repository → Service → Command → invoke → Store → Component
- [ ] 写入流: Component → Store → Service → invoke → Command → Service → Repository → SQLite
- [ ] 类型在各层之间是否正确传递？
- [ ] 错误是否正确传播到调用方？
- [ ] 加载/等待状态在各层是否处理？

---

## 维度 B: 代码复用

**触发**: 修改常量、配置值、硬编码值

```bash
# 搜索修改的值在项目中出现的次数
grep -r "值" src/ src-tauri/src/
```

- [ ] 如果 2+ 处定义相同值 → 应提取共享常量
- [ ] 修改后所有使用位置都更新了？

---

## 维度 C: 导入路径（创建新文件时必检）

- [ ] 使用正确的导入路径（`@/` 别名）？
- [ ] 无循环依赖？
- [ ] 与项目模块组织一致？
- [ ] 新增的 mod/export 已在 `mod.rs` / `index.ts` 中注册？

---

## 维度 D: 同层一致性

- [ ] 搜索同一概念的其他用法
- [ ] 用法是否一致？
- [ ] 应该共享配置/常量？

---

## 输出

报告：
1. 变更涉及哪些维度
2. 每个维度的检查结果
3. 发现的问题和修复建议
