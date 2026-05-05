# CC-Panes Markdown-First Memory 方案

状态：Draft
日期：2026-05-02
目标：把 CC-Panes Memory 从当前 DB-first、手工管理、独立 MCP 的形态，升级为工作空间优先、Markdown 可读可审计、JSON 索引加速、Hooks 自动捕获与注入的自有记忆系统。

---

## 1. 背景

当前仓库里已经有一套 Memory v1：

- `cc-memory`：SQLite + FTS5 的记忆库。
- `cc-memory-mcp`：独立 MCP server，提供 `memory_add/search/update/delete/daily_report`。
- `cc-panes-core/src/services/memory_service.rs`：封装 `cc_memory::MemoryService`，并提供 `prepare_session_context`。
- `src-tauri/src/commands/memory_commands.rs`：Tauri IPC 命令。
- `web/components/memory/MemoryManager.tsx`：前端手工管理界面。
- `cc-panes-cli-hook/src/session_start.rs`：启动时通过 `cc-memory-mcp search` 读取 `~/.cc-panes/memory.db` 注入上下文。

v1 的问题不是“不能用”，而是不像 CC-Panes 自己的工作流记忆：

- DB 是唯一真实源，用户很难直接读、审、改、版本化。
- Memory UI 偏手工 CRUD，和会话生命周期没有形成闭环。
- `cc-memory-mcp` 是独立二进制，和现有 `ccpanes` Orchestrator MCP 割裂。
- SessionStart hook 依赖固定路径和外部二进制，dev/release、打包、WSL Codex 都容易断。
- 没有稳定的自动入库机制，会话结束后不会自然沉淀经验。

---

## 2. 设计结论

第一版不要直接做复杂知识图谱、向量库或长期“类大脑”系统。先做一个更稳的基础层：

1. **Markdown 是 source of truth**
   记忆文件直接放在工作空间目录，用户能读、能改、能 git diff。

2. **JSON 索引是运行时加速层**
   `_index.json` 只做缓存和路由，坏了可以从 Markdown 重建。

3. **Hooks 负责自动捕获和启动注入**
   SessionStart 做 recall，Stop/SessionEnd 类事件做 harvest。

4. **MCP 合并到 `ccpanes` Orchestrator MCP**
   不再让 agent 依赖独立 `cc-memory-mcp` 二进制。

5. **四层实用记忆模型**
   `core`、`working`、`episodic`、`archive`，先解决日常可用和污染控制。

参考开源项目时，借鉴方向如下：

- Basic Memory：文件优先、Markdown 可读、索引可重建的思路。
- OpenMemory / mem0：用户拥有记忆，agent 通过 MCP 管理记忆。
- Graphiti：会话事件和时间关系很有价值，但图谱化放到后续版本。
- mcp-memory-service：Session end 自动提取记忆的 hook 模式值得参考。

---

## 3. 存储位置

优先把记忆放到工作空间目录：

```text
<workspace_path>/.ccpanes/memory/
```

如果当前没有 workspace path，则回退到 app 数据目录：

```text
Dev:     ~/.cc-panes-dev/memory/
Release: ~/.cc-panes/memory/
```

读取时必须同时考虑：

- 当前 workspace 记忆。
- 当前 project path 匹配的项目记忆。
- app 数据目录里的 fallback 记忆。
- 旧版 `memory.db` 迁移状态。

---

## 4. 目录结构

```text
.ccpanes/memory/
├── core/
│   ├── preferences.md
│   ├── architecture.md
│   └── project-map.md
├── working/
│   ├── current-focus.md
│   ├── decisions.md
│   └── blockers.md
├── episodic/
│   └── 2026-05/
│       ├── session-20260502-143012.md
│       └── session-20260502-175901.md
├── archive/
│   └── 2026/
│       └── old-decisions.md
├── _index.json
├── _index.md
└── config.toml
```

四层含义：

| Layer | 用途 | 注入策略 |
|-------|------|----------|
| `core` | 长期偏好、架构事实、稳定约定 | 高优先级，启动时少量常驻 |
| `working` | 当前任务、近期决定、未完成事项 | 当前 workspace/project 高优先级注入 |
| `episodic` | 会话总结、踩坑记录、具体事件 | 只按相关性和近期注入 |
| `archive` | 低频、过期、已完成或历史记录 | 默认不注入，手搜时可查 |

---

## 5. Markdown 文件格式

每条记忆是一个 Markdown 文件，YAML frontmatter 存结构化字段，正文存人可读内容。

```markdown
---
id: mem_20260502_143012_ab12
schema_version: 1
layer: working
scope: project
workspace_name: cc-panes
project_path: /mnt/d/04_workspace_rust/cc-book
category: decision
importance: 4
confidence: 0.86
status: active
source: hook
tags:
  - memory
  - hooks
triggers:
  - memory
  - session-start
related: []
source_session_id: 7f0d...
source_transcript_path: /home/user/.claude/projects/.../session.jsonl
created_at: 2026-05-02T14:30:12+08:00
updated_at: 2026-05-02T14:30:12+08:00
last_accessed_at:
access_count: 0
---

# SessionStart memory injection should read Markdown index directly

## Summary

启动注入不能再依赖独立 `cc-memory-mcp` 二进制，hook runner 应直接读取 workspace memory index。

## Details

- 当前实现会寻找 `cc-memory-mcp` 并读取固定 `~/.cc-panes/memory.db`。
- 这在 dev/release 隔离、打包、WSL Codex 场景下都不稳。
- 新实现应由 `cc-panes-cli-hook session-start` 读取 `_index.json` 和必要 Markdown 文件。

## Evidence

- Source session: `7f0d...`
- Source event: `SessionStart/Stop`
```

字段约定：

| 字段 | 说明 |
|------|------|
| `id` | 稳定唯一 ID，迁移和重建索引时不变 |
| `layer` | `core` / `working` / `episodic` / `archive` |
| `scope` | `global` / `workspace` / `project` / `session` |
| `category` | `decision` / `lesson` / `preference` / `pattern` / `fact` / `plan` / `issue` / `custom` |
| `importance` | 1-5，决定注入优先级 |
| `confidence` | 0-1，自动提取时用于抗污染 |
| `status` | `active` / `superseded` / `archived` |
| `source` | `manual` / `hook` / `mcp` / `migration` / `user` |
| `triggers` | 精确召回关键词，不等同全文搜索 |

Rust 实现建议使用 `serde_yaml` 解析 frontmatter，正文保持 Markdown 原文。

---

## 6. 索引设计

`_index.json` 是机器读索引，hook 和 MCP 都优先读它：

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-02T14:30:12+08:00",
  "workspace_name": "cc-panes",
  "workspace_path": "/mnt/d/04_workspace_rust/cc-book",
  "documents": [
    {
      "id": "mem_20260502_143012_ab12",
      "path": "working/decisions.md",
      "title": "SessionStart memory injection should read Markdown index directly",
      "layer": "working",
      "scope": "project",
      "project_path": "/mnt/d/04_workspace_rust/cc-book",
      "category": "decision",
      "importance": 4,
      "confidence": 0.86,
      "status": "active",
      "tags": ["memory", "hooks"],
      "triggers": ["memory", "session-start"],
      "created_at": "2026-05-02T14:30:12+08:00",
      "updated_at": "2026-05-02T14:30:12+08:00",
      "snippet": "启动注入不能再依赖独立 cc-memory-mcp 二进制..."
    }
  ]
}
```

`_index.md` 是给人看的目录：

```markdown
# Memory Index

## Working

- [SessionStart memory injection should read Markdown index directly](working/decisions.md)
  `decision` · importance 4 · triggers: `memory`, `session-start`
```

索引规则：

- Markdown 写入成功后，原子更新 `_index.json`。
- `_index.json` 损坏或缺失时，从 Markdown 全量重建。
- 文件删除、重命名、层级变更后必须 rebuild。
- 多进程写入需要 lock file，避免 Claude/Codex hooks 同时写。

---

## 7. Recall 策略

输入：

- `workspace_name`
- `workspace_path`
- `project_path`
- `session_id`
- `query`
- 最近用户消息和工具上下文

候选来源：

1. 当前 project 精确匹配。
2. 当前 workspace 匹配。
3. global/fallback app memory。
4. archive 仅在手动搜索或明确触发时进入候选。

排序建议：

```text
score =
  scope_match * 30
+ trigger_match * 25
+ importance * 10
+ confidence * 10
+ recency_bonus
+ access_bonus
- archive_penalty
```

启动注入预算：

- `core`：最多 3 条。
- `working`：最多 5 条。
- `episodic`：最多 3 条。
- `archive`：默认 0 条。
- 总 Markdown 输出控制在 2500-4000 tokens 左右。

SessionStart 输出格式：

```markdown
## CC-Panes Memory

### Core

- ...

### Working

- ...

### Recent Lessons

- ...
```

---

## 8. 自动入库

自动入库分两条路径：

1. **Agent 主动写入**
   agent 通过 `ccpanes` MCP 调 `memory_add`，适合明确偏好、决策、踩坑。

2. **Hook 自动收尾**
   `cc-panes-cli-hook memory-harvest` 在会话停止时读取 transcript 或最近输出，提取可沉淀内容。

Claude Code：

- 接 `Stop` hook。
- 如果当前 Claude Code 版本支持更明确的 SessionEnd 类事件，再一起接入。
- 优先使用 hook input 里的 `transcript_path`、`last_assistant_message`、`cwd`、`session_id`。

Codex：

- 以当前仓库 `cc-cli-adapters` 的 hook 支持为准。
- 优先级按用户要求处理：Codex for WSL 优先，其次 macOS/local，再其次通用本地 Codex。
- WSL Codex 不能直接运行 Windows host 的 hook binary，需要生成 WSL 侧 shell hook 或通过 HTTP API 回调 CC-Panes。

提取规则第一版先保守：

| 信号 | 默认层级 | 例子 |
|------|----------|------|
| 用户明确说“记住/以后/偏好/不要再” | `core` 或 `working` | “以后这个项目都用 pnpm” |
| 架构决策、方案选择、接口约定 | `working` | “Memory 改为 Markdown-first” |
| 修复过的坑、测试失败原因 | `episodic` | “WSL Codex hook 不能跑 Windows exe” |
| 已完成任务摘要 | `episodic` | “完成 docs 方案” |
| 过期、低信心、重复内容 | `archive` | 历史流水账 |

抗污染规则：

- 没有明确证据的内容只进 `episodic`，不进 `core`。
- `core` 写入需要更高 confidence 或用户明确表达。
- 同类记忆先更新已有文件，不默认新增重复文件。
- 冲突时新记忆标记 `related`，旧记忆改为 `superseded`，不要直接覆盖删除。

---

## 9. MCP 工具

Memory 工具应并入现有 `ccpanes` Orchestrator MCP，不再依赖独立 `cc-memory-mcp`。

建议工具：

| Tool | 用途 |
|------|------|
| `memory_add` | 新增 Markdown memory |
| `memory_search` | 搜索记忆 |
| `memory_recall` | 按当前 session/project 做注入级召回 |
| `memory_update` | 更新 frontmatter 或正文 |
| `memory_archive` | 移入 archive |
| `memory_promote` | `episodic` -> `working` / `working` -> `core` |
| `memory_rebuild_index` | 从 Markdown 重建 `_index.json` |
| `memory_stats` | 返回层级、项目、更新时间统计 |

兼容策略：

- `cc-memory-mcp` 保留一个版本，只作为兼容入口。
- 新功能优先走 Orchestrator MCP。
- 打包时不再要求 `cc-memory-mcp` 二进制参与 SessionStart 注入。

---

## 10. 前端 UI

改造 `MemoryManager`，不要只做 CRUD 表单。

建议布局：

- 左侧：Layer 分组和 workspace/project filter。
- 中间：记忆列表，支持搜索、标签、重要级别、状态过滤。
- 右侧：Markdown 预览和 frontmatter 编辑。
- 顶部操作：新增、重建索引、迁移旧 DB、打开目录。
- 单条操作：promote、archive、edit、delete、view source session。

UI 重点：

- 默认展示当前 workspace/project 记忆。
- `core` 写入要有明显提示，因为它会长期影响 agent。
- `episodic` 支持批量归档和提升。
- 索引状态要可见：正常、缺失、损坏、需要 rebuild。

---

## 11. 迁移方案

迁移从旧 `memory.db` 到 Markdown：

1. 检测 app 数据目录下的 `memory.db`。
2. 读取旧 `Memory` 记录。
3. 按 `scope/category/importance/project_path` 映射到 Markdown 文件。
4. 保留旧 ID、时间戳、重要级别、标签、内容。
5. frontmatter 标记 `source: migration`。
6. 写入 `_migration-log.md`。
7. 保留旧 DB，不自动删除。

迁移映射：

| 旧字段 | 新字段 |
|--------|--------|
| `scope` | `scope` |
| `category` | `category` |
| `importance` | `importance` |
| `project_path` | `project_path` |
| `content` | Markdown body |
| `tags` | `tags` |
| `created_at/updated_at` | 同名字段 |

迁移必须幂等：

- 同一个旧 ID 已迁移时不重复生成。
- 手工编辑过的新 Markdown 不被迁移覆盖。
- 可以通过 UI 手动重新 rebuild index。

---

## 12. 实施拆解

### Phase 1：Markdown 存储内核

改动范围：

- `cc-memory/src/models.rs`
- `cc-memory/src/service.rs`
- 新增 `cc-memory/src/markdown_store.rs`
- 新增 `cc-memory/src/index.rs`
- 新增 `cc-memory/src/resolver.rs`

任务：

- 增加 `MemoryDocument`、`MemoryFrontmatter`、`MemoryLayer`。
- 实现 Markdown parse/write。
- 实现 `_index.json` rebuild。
- 实现 recall scoring。
- 增加 parser/index/resolver 单元测试。

### Phase 2：Core/Tauri 服务替换

改动范围：

- `cc-panes-core/src/services/memory_service.rs`
- `src-tauri/src/commands/memory_commands.rs`
- `src-tauri/src/lib.rs`

任务：

- MemoryService 初始化时解析 workspace/app fallback 路径。
- 保持现有 Tauri command API 尽量兼容。
- 新增 rebuild/promote/archive/migrate 命令。

### Phase 3：Hooks 接入

改动范围：

- `cc-panes-cli-hook/src/main.rs`
- `cc-panes-cli-hook/src/session_start.rs`
- 新增 `cc-panes-cli-hook/src/memory_harvest.rs`
- 新增 `cc-panes-core/src/services/memory_transcript_watcher.rs`
- `cc-cli-adapters/src/claude.rs`
- `cc-cli-adapters/src/codex.rs`
- `cc-panes-core/src/services/terminal_service/wsl_codex.rs`

任务：

- `session-start` 直接读取 Markdown index，不再调用 `cc-memory-mcp`。
- 新增 `memory-harvest` subcommand。
- Claude hooks 写入 Stop/SessionStart。
- Codex 主路径使用 transcript watcher 监听 `~/.codex/sessions/**/*.jsonl`。
- Codex hooks 按 local/macOS/WSL 分支作为可选增强生成。
- WSL Codex 优先通过 transcript watcher + workspace `AGENTS.md` 注入；HTTP callback 只作为增强路径。

### Phase 4：Orchestrator MCP 工具

改动范围：

- `src-tauri/src/services/orchestrator_service.rs`
- 相关 API command/service。

任务：

- 增加 memory MCP tools。
- agent 可通过 `ccpanes.memory_add/search/timeline/get/recall` 使用同一套记忆。
- `memory_search` 默认返回 compact index，`memory_get` 批量返回完整 Markdown。
- 保留 `cc-memory-mcp` 兼容，不再作为主路径。

### Phase 5：前端管理界面

改动范围：

- `web/types/memory.ts`
- `web/services/memoryService.ts`
- `web/stores/useMemoryStore.ts`
- `web/components/memory/MemoryManager.tsx`
- 可复用 `MemoryPickerDialog.tsx`

任务：

- 支持 layer、status、confidence、triggers、source 信息。
- 支持 rebuild index、promote、archive、migration。
- 支持 Markdown preview/edit。
- 支持 SessionStart 注入预览和 token 估算。

### Phase 6：迁移和清理

任务：

- 实现 `memory.db` -> Markdown 迁移。
- 更新 docs。
- 清理打包对 `cc-memory-mcp` 的隐式依赖。
- 加端到端验证脚本。

---

## 13. 测试计划

当前环境可验证：

- `cargo fmt --all -- --check`
- `cargo check --workspace`
- `cargo test -p cc-memory`
- `cargo test -p cc-panes-cli-hook`
- `npm run test:run`
- `npx tsc --noEmit`

重点单测：

- YAML frontmatter parse/write。
- Markdown 文件原子写入。
- `_index.json` rebuild。
- index 损坏 fallback。
- recall scoring。
- migration 幂等。
- duplicate/superseded 处理。
- hook input fixture 解析。

Windows-host-required 验证：

- Tauri app 启动和 app data path。
- Release/dev 数据隔离。
- Claude Code hooks 安装与执行。
- Codex local hooks 安装与执行。
- Codex for WSL session-start 和 memory-harvest。
- WebView 中 MemoryManager 打开目录、编辑、保存。

---

## 14. 验收标准

第一版完成时必须满足：

1. 新建 memory 默认写入 `<workspace_path>/.ccpanes/memory/`。
2. 无 workspace path 时写入 app 数据目录 memory。
3. `_index.json` 可从 Markdown 全量重建。
4. SessionStart 不再依赖 `cc-memory-mcp`，能直接注入相关记忆。
5. SessionStart 注入包含 compact index，而不是只塞完整详情。
6. 会话停止后能自动生成或更新至少一条 `episodic` 记忆。
7. Codex transcript watcher 能从 JSONL 中产生 session/prompt/tool/summary 事件。
8. agent 能通过 `ccpanes` MCP 搜索、新增、按 timeline 查看、批量读取记忆。
9. 旧 `memory.db` 可以迁移到 Markdown，且迁移幂等。
10. UI 能按 layer 管理、搜索、提升、归档记忆，并预览启动注入内容。

---

## 15. 风险和处理

| 风险 | 处理 |
|------|------|
| 自动入库污染 `core` | `core` 需要高 confidence 或用户显式偏好 |
| hooks 并发写文件 | lock file + atomic rename |
| Markdown 被用户手改坏 | parser 给出具体错误，index 可跳过坏文件并提示 |
| WSL Codex 无法执行 host binary | WSL shell hook 或 HTTP callback |
| Codex hook 能力不稳定 | 优先支持 transcript watcher，hooks 只作为可选增强 |
| 旧 DB 和新 Markdown 双写混乱 | 新系统只写 Markdown，旧 DB 只迁移读取 |
| recall token 过多 | 按 layer 限额和 score 截断 |

---

## 16. 后续版本

第一版稳定后再考虑：

- 轻量全文索引或 Tantivy。
- temporal graph / relationship graph。
- 周期性 consolidation，把 episodic 提炼为 working/core。
- session raw archive 冷存储。
- 跨 workspace 的 global preference。
- 可视化 memory graph。

---

## 17. claude-mem 调研补充

调研对象：

- Repo: <https://github.com/thedotmack/claude-mem>
- Local reference clone: `/tmp/ccpanes-refs/claude-mem`
- Inspected revision: `28b40c0` (`2026-04-29`, `docs: update CHANGELOG.md for v12.4.9`)

### 17.1 它的核心架构

`claude-mem` 是一套完整的记忆运行时：

- Claude Code plugin hooks 捕获生命周期事件。
- Worker service 常驻后台，提供 HTTP API、SSE viewer、异步队列和搜索接口。
- SQLite 存 session、prompt、observation、summary、pending queue。
- FTS5 做关键词搜索，Chroma 做可选语义搜索。
- MCP server 只是 thin wrapper，把 MCP tool call 转成 worker HTTP API。
- `mem-search` skill 教 agent 按 `search -> timeline -> get_observations` 的三层流程取记忆。

这说明 CC-Panes 不应把 Memory 做成“前端 CRUD + 启动时塞几条文本”。更合理的是：

- Tauri/Core 里有一个统一 Memory runtime。
- Hooks、MCP、UI 都调用同一套服务。
- 耗时提炼异步化，hook 本身快速返回。

### 17.2 最值得借鉴的模式

#### 模式一：Progressive Disclosure

`claude-mem` 不鼓励启动时注入完整历史，而是先给索引、ID、类型、标题和读取成本，再让 agent 决定是否拉取详情。

CC-Panes 应采用类似策略：

1. SessionStart 注入 `core` + `working` 的少量高置信内容。
2. 同时注入 compact memory index，包含 ID、layer、title、importance、estimated tokens。
3. agent 需要时通过 `memory_timeline` / `memory_get` 拉详情。

建议新增 MCP 工具：

| Tool | 用途 |
|------|------|
| `memory_search` | 返回 compact index |
| `memory_timeline` | 以 memory ID/session 为锚点返回上下文 |
| `memory_get` | 批量返回完整 Markdown 详情 |

这比只做 `memory_search` 更稳，因为它把 token 预算交给 agent 控制。

#### 模式二：Hook 快速返回，处理异步化

`claude-mem` 的 hook 只负责 normalize input、发给 worker、失败时 fail-open；观察压缩和总结由 worker 异步处理。

CC-Panes 应避免在 hook 进程里直接做大模型提炼或大量文件扫描：

- `SessionStart`：只读 `_index.json` 和少量 Markdown，必须快。
- `PostToolUse/UserPromptSubmit`：只入队或轻量记录。
- `Stop/SessionEnd`：只提交 harvest request，后台异步写 `episodic`。
- Worker/后台任务：负责去重、压缩、promote、archive、rebuild index。

#### 模式三：边界层隐私过滤

`claude-mem` 支持 `<private>...</private>`，在 hook/ingest 边界剥离，避免敏感内容进入 DB 和搜索索引。

CC-Panes 第一版应支持同类规则：

- `<private>...</private>`：不持久化。
- `<ccpanes-memory-ignore>...</ccpanes-memory-ignore>`：不进入 memory。
- 自动注入内容要用专门标签包裹，防止被下一轮重新采集形成递归污染。

#### 模式四：跳过低价值工具和元观察

`claude-mem` 默认跳过 `TodoWrite`、slash command、skill 等低价值或元工具。

CC-Panes 也应有 skip list：

```toml
[harvest]
skip_tools = ["TodoWrite", "ListMcpResourcesTool", "SlashCommand", "Skill", "AskUserQuestion"]
skip_paths = [".ccpanes/memory", ".git", "node_modules", "target"]
```

尤其要跳过 `.ccpanes/memory` 自己的读写，否则 memory 系统会记忆自己的维护动作。

#### 模式五：Codex transcript watcher

`claude-mem` 对 Codex CLI 不是强行安装 notify hook，而是监听 `~/.codex/sessions/**/*.jsonl`，用 schema 把 transcript 事件映射成：

- `session_context`
- `session_init`
- `tool_use`
- `tool_result`
- `assistant_message`
- `session_end`

这对 CC-Panes 很关键。Codex for WSL / macOS / local 的 hook 能力和执行环境差异大，第一优先级应改为：

1. **Codex transcript watcher**：监听 session JSONL，解析事件，写入 memory queue。
2. **Workspace `AGENTS.md` / project instruction file 注入**：给 Codex 注入 compact memory index。
3. **Codex hooks**：只作为可选增强，不作为唯一链路。

这样比“让 WSL Codex 调 Windows host binary”更稳。

### 17.3 不建议直接照搬的点

不建议第一版照搬这些：

- Bun/Node worker：CC-Panes 已经有 Rust/Tauri core 和 HTTP API，不需要再引入一套 Bun runtime。
- Chroma：先用 Markdown index + FTS/简单评分，向量库放后续。
- 全量 SQLite source of truth：和本方案 Markdown-first 冲突。
- 插件 marketplace 安装流：CC-Panes 自己负责 hook 安装和项目配置。
- 复杂 knowledge corpus/agent：可以后续做，第一版先保证自动记忆闭环稳定。

### 17.4 对本方案的调整

结合 `claude-mem` 后，本方案做以下调整：

1. **新增 transcript watcher 作为 Codex 主路径**
   在 `cc-panes-core` 或 API 后台服务中监听 Codex JSONL，而不是完全依赖 Codex hooks。

2. **MCP 工具改成三层检索**
   `memory_search -> memory_timeline -> memory_get`，不要只提供全文搜索。

3. **SessionStart 注入 compact index**
   只给少量核心内容和可检索目录，避免上下文污染。

4. **harvest queue 异步处理**
   hook 不直接做 LLM 提炼，只提交事件或 transcript 位置。

5. **隐私和递归污染规则前置**
   在 hook/transcript ingest 入口过滤 `<private>`、自动注入标签和 memory 自身文件。

6. **UI 增加“注入预览”**
   MemoryManager 应能显示下一次 SessionStart 会注入什么、估计多少 tokens。

---

## 18. 参考资料

- Basic Memory technical information: <https://docs.basicmemory.com/reference/technical-information>
- OpenMemory / mem0: <https://mem0.ai/openmemory>
- Graphiti: <https://github.com/getzep/graphiti>
- mcp-memory-service: <https://github.com/doobidoo/mcp-memory-service>
- claude-mem: <https://github.com/thedotmack/claude-mem>
- Claude Code hooks: <https://docs.anthropic.com/en/docs/claude-code/hooks>
