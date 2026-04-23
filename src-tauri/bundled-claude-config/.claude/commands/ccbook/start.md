# 启动会话

初始化 AI 开发会话并开始工作。

---

## 初始化步骤

### 步骤 1: 了解项目

```bash
cat CLAUDE.md
```

### 步骤 2: 获取当前状态

```bash
git status
git log --oneline -5
```

### 步骤 3: 阅读规范索引

```bash
cat .trellis/spec/frontend/index.md
cat .trellis/spec/backend/index.md
cat .trellis/spec/tauri/index.md
```

### 步骤 4: 报告并询问

报告当前项目状态，然后询问："你想做什么？"

---

## 任务分类

| 类型 | 标准 | 工作流 |
|------|------|--------|
| **问题** | 关于代码、架构或工作原理的提问 | 直接回答 |
| **小修复** | 拼写修正、注释更新、单行修改 | 直接编辑 |
| **开发任务** | 修改逻辑、添加功能、修复 bug、多文件变更 | **任务工作流** |

### 判断规则

> **有疑问时，使用任务工作流。**

---

## 任务工作流

### 1. 理解任务

理解用户需求，判断开发类型（frontend / backend / tauri-fullstack）

### 2. 研究代码库

使用 Research Agent 分析相关代码和规范

### 3. 实现

对于 tauri-fullstack 类型，按 7 步流程：
Model → Repository → Service(Rust) → Command → Service(TS) → Store → Component

### 4. 检查质量

- `/ccbook:check-frontend` - 前端代码检查
- `/ccbook:check-backend` - 后端代码检查
- `/ccbook:check-tauri-bridge` - 桥接一致性检查

### 5. 完成

- 验证 lint 和 typecheck 通过
- 报告实现内容
- 提醒用户测试和提交
