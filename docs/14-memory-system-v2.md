# CC-Panes Memory System v2 — 架构设计文档

## Context

现有 `cc-memory` + `cc-memory-mcp` 提供了基础的 SQLite + FTS5 记忆系统（5 个 MCP 工具），但缺乏 URI 图谱路由、触发条件、版本控制、自动捕获和睡眠提纯等高级能力。本设计文档受 Nocturne Memory 启发，在现有基础上渐进式增强，将 CC-Panes 的记忆系统从"被动检索"升级为"主权智能体记忆"。

---

## 一、设计哲学

### 为什么 Vector RAG 不够

1. **余弦相似度是盲盒** — 回答的是"语义距离"，不是"此刻该想起什么"
2. **第一人称主权** — AI 自己决定记什么，不是后台自动摘要的监控笔记
3. **精准条件路由 vs 模糊搜索** — 用户说"deploy"时精确想起上次部署注意事项，不是返回一堆碎片
4. **领域隔离** — Java 经验不串入 Rust 上下文，URI domain 前缀天然实现
5. **睡眠提纯** — 情景记忆（Journal 流水账）→ 提纯引擎 → 语义记忆（可复用知识）

---

## 一.五、认知学习法融合

将人类认知科学中经过验证的学习机制映射为系统机制，让 AI 记忆系统具备"学习能力"而非仅仅"存储能力"。

| 人类认知 | 系统机制 | 落地位置 |
|---------|---------|---------|
| 艾宾浩斯遗忘曲线 | Decay + Hit Count | 经验库（memories 表） |
| 费曼技巧 | 白话测试质量关卡 | 睡眠提纯引擎 |
| 组块化学习 (Chunking) | 周期巡检 + 自动打包 | 后台巡检任务 |
| 感觉记忆 / 潜意识 | CLI 原始对话归档 | 文件系统冷存储 |

### 1.5.1 艾宾浩斯遗忘曲线 → 动态权重衰减

人类记忆遵循遗忘曲线：不复习的知识会指数级遗忘，而每次回忆都会强化记忆痕迹。系统通过 `decay_weight` 和 `hit_count` 模拟这一机制：

- **衰减**：每条 Memory 的 `decay_weight` 随时间自然衰减（指数衰减函数）
- **强化**：每次被 `memory_recall` / `memory_search` 命中时，`hit_count += 1`，衰减权重获得加成
- **淘汰**：`decay_weight < 0.1` 的 Memory 在排序中自然沉底，不再浮现
- **固化**：高频命中的 Memory 晋升为"肌肉记忆"，标记 `pinned`，永不衰减

**权重计算公式**：

```
decay_weight = base_weight × e^(-λ × days_since_last_access) + hit_bonus
```

- `base_weight = 1.0`（初始权重）
- `λ = 0.05`（衰减系数，可通过 `config.toml` 配置）
- `days_since_last_access` = 距上次触达的天数
- `hit_bonus = min(hit_count × 0.02, 0.5)`（命中加成，上限 0.5）

**肌肉记忆固化规则**：当 `hit_count >= 50 && decay_weight >= 0.8` → 自动标记为 `pinned`（永不衰减）。

### 1.5.2 费曼技巧 → 白话测试质量关卡

费曼技巧的核心：如果你无法用简单的话解释一个概念，说明你还没真正理解它。系统在睡眠提纯阶段引入"白话测试"：

- 提纯引擎对每条提取的经验，要求 LLM 用一句大白话概括核心逻辑
- 如果无法用一句话概括 → 说明逻辑链路不完整 → 标记 `feynman_pass: false`，原样保留原始日记不入库
- 如果概括成功 → `feynman_pass: true`，白话摘要存入 `consolidated_summary` 字段
- 白话摘要同时用于 Glossary 术语表的自动生成

### 1.5.3 组块化学习 (Chunking) → 经验横向连结

人类专家之所以高效，在于将零散知识组织为"组块"（chunk）。系统通过周期巡检将相关经验自动打包为高层知识节点：

- 扫描近期新增 Memory，分析语义关联
- LLM 识别共性主题，创建父级 Node + `PartOf` Edge
- 将零散经验连结为架构级知识组块
- 组块本身成为新的可触发知识单元

### 1.5.4 感觉记忆 → 潜意识层 (Layer 10)

人类感觉记忆是最底层的信息缓冲，大量信息在此短暂停留后被遗忘，但在需要时可以回溯。系统在三层架构下方新增"潜意识层"：

- 保存 CLI 原始对话流作为最底层冷存储
- 正常运行时上层 Layer 1-9 **绝不触碰**此层（零 Token 消耗）
- 当经验库被污染或提纯方向错误时，可从原始对话流重新提纯（容灾回溯）

---

## 二、四层分离架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1-3: 触点层 (Touch Layer)         [内存常驻]      │
│  Glossary(Aho-Corasick) + TriggerRegistry + URI Router  │
├─────────────────────────────────────────────────────────┤
│  Layer 4-6: 经验库 (Knowledge Graph)     [SQLite]       │
│  Node + Memory + Edge + Path + Snapshot + Trigger       │
├─────────────────────────────────────────────────────────┤
│  Layer 7-9: 实体层 (Document Layer)      [MD 文件]      │
│  workflow.md + journal/*.md + CLAUDE.local.md            │
├─────────────────────────────────────────────────────────┤
│  Layer 10:  潜意识层 (Subconscious)      [日志归档]      │
│  CLI Session Logs — 原始对话流，冷存储，仅容灾回溯       │
└─────────────────────────────────────────────────────────┘
```

- **触点层**：常驻内存，Aho-Corasick 多模式匹配，日常零开销，撞上关键词立刻中断查询
- **经验库**：SQLite 存储，Node-Memory-Edge-Path 图拓扑 + Trigger + Snapshot 版本链
- **实体层**：MD 文件保留完整文档实体性。经验归经验，正文归正文
- **潜意识层**：CLI 原始对话流冷存储，正常运行时零消耗，仅在容灾回溯时触碰

### 2.4 潜意识层 (Subconscious Layer)

潜意识层是记忆系统的最底层缓冲，灵感来自人类的"感觉记忆"——大量信息在此短暂停留，绝大部分被遗忘，但在需要时可以追溯。

**数据源**：每次 CLI 会话的完整输入输出流（已有 Journal 日志 + Claude 原始 JSONL）

**存储位置**：`~/.cc-panes/subconscious/` 按日期归档，gzip 压缩

**存储格式**：保留原始 JSONL 对话流（用户输入 + AI 输出 + 工具调用）

```
~/.cc-panes/subconscious/
├── 2024-01/
│   ├── session-abc123.jsonl.gz
│   ├── session-def456.jsonl.gz
│   └── ...
├── 2024-02/
│   └── ...
└── ...
```

**访问策略**：正常运行时 Layer 1-9 **绝不主动触碰**此层（零 Token 消耗）

**容灾回溯**：当经验库被污染或发现早期提纯方向错误时，可从原始对话流重新提纯

```
subconscious/*.jsonl.gz
    ↓ 解压 + 解析
原始对话流
    ↓ 重新运行睡眠提纯（可换 Prompt / 模型）
修正后的语义记忆
```

**保留策略**：默认保留 90 天，可通过 `config.toml` 配置

**空间预估**：单次会话 ~50KB 压缩后，日均 10 次 ≈ 500KB/天 ≈ 15MB/月

**配置项**（`config.toml`）：

```toml
[subconscious]
enabled = true
retention_days = 90        # 保留天数
max_size_mb = 500          # 最大占用空间
archive_path = "subconscious"  # 相对于 ~/.cc-panes/ 的路径
```

---

## 三、URI 图谱路由

**格式**: `<domain>://<scope>/<path>`

| 作用域 | URI 前缀 | 示例 |
|--------|----------|------|
| Global | `core://global/` | `core://global/identity` |
| Workspace | `ws://<name>/` | `ws://cc-panes/architecture` |
| Project | `project://<path>/` | `project://cc-book/deploy-notes` |
| Session | `session://<id>/` | `session://abc123/context` |

**领域隔离示例**：

```
rust://project/architecture    -- Rust 项目架构
react://project/patterns       -- React 模式
deploy://project/checklist     -- 部署清单
```

Alias 别名：同一 Memory 可从多个 URI 访问。URI Router 用前缀树（Trie）实现。

---

## 四、数据模型（增量扩展现有 Memory）

### 4.1 Memory 表新增字段

```rust
// 追加到现有 Memory struct
pub uri: Option<String>,
pub domain: Option<String>,
pub node_id: Option<String>,
pub parent_id: Option<String>,
pub version: u32,              // 从 1 开始
pub deprecated: bool,
pub migrated_to: Option<String>,
pub disclosure: Option<String>, // 触发条件 JSON
pub hit_count: u32,               // 命中次数（被 recall/search 触达）
pub last_accessed_at: Option<String>, // 最后触达时间
pub decay_weight: f64,            // 当前衰减权重 (0.0~1.0)
pub consolidated_summary: Option<String>, // 费曼白话摘要（通过白话测试后填入）
```

### 4.2 新增实体

| 实体 | 表名 | 核心字段 | 用途 |
|------|------|---------|------|
| Node | `nodes` | id, uri(UNIQUE), name, domain, scope, node_type, aliases | 知识节点（概念锚点） |
| Edge | `edges` | source_node_id, target_node_id, relation, weight | 有向关系（DependsOn/Implements/Supersedes/RelatedTo/PartOf/Triggers） |
| Trigger | `triggers` | memory_id, trigger_type, pattern, priority, enabled | 条件触发（Keyword/Regex/UriPrefix/SessionEvent/ToolEvent） |
| Glossary | `glossary` | term, definition, memory_ids, domain, scope | 术语表（Aho-Corasick 匹配源） |
| Snapshot | `snapshots` | memory_id, version, title, content, changed_by, change_reason | 版本快照 |

### 4.3 详细 Schema

#### nodes 表

```sql
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    uri TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    domain TEXT,
    scope TEXT NOT NULL DEFAULT 'project',
    node_type TEXT NOT NULL DEFAULT 'concept',
    aliases TEXT,           -- JSON array of alias URIs
    metadata TEXT,          -- JSON object
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_uri ON nodes(uri);
CREATE INDEX IF NOT EXISTS idx_nodes_domain ON nodes(domain);
CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope);
```

#### edges 表

```sql
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    relation TEXT NOT NULL,    -- DependsOn/Implements/Supersedes/RelatedTo/PartOf/Triggers
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT,             -- JSON object
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    UNIQUE(source_node_id, target_node_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
```

#### triggers 表

```sql
CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,  -- Keyword/Regex/UriPrefix/SessionEvent/ToolEvent
    pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,               -- JSON object
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_triggers_memory ON triggers(memory_id);
CREATE INDEX IF NOT EXISTS idx_triggers_type ON triggers(trigger_type);
CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);
```

#### glossary 表

```sql
CREATE TABLE IF NOT EXISTS glossary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    definition TEXT NOT NULL,
    memory_ids TEXT,             -- JSON array of linked memory IDs
    domain TEXT,
    scope TEXT NOT NULL DEFAULT 'project',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_term_domain ON glossary(term, domain);
```

#### snapshots 表

```sql
CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    importance INTEGER,
    tags TEXT,                   -- JSON array
    metadata TEXT,               -- JSON object (full field snapshot)
    changed_by TEXT,             -- 'user' / 'system' / 'consolidation'
    change_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
    UNIQUE(memory_id, version)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_memory ON snapshots(memory_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_version ON snapshots(memory_id, version);
```

### 4.4 memories 表迁移

```sql
-- 增量迁移，不影响现有数据
ALTER TABLE memories ADD COLUMN uri TEXT;
ALTER TABLE memories ADD COLUMN domain TEXT;
ALTER TABLE memories ADD COLUMN node_id TEXT;
ALTER TABLE memories ADD COLUMN parent_id TEXT;
ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN migrated_to TEXT;
ALTER TABLE memories ADD COLUMN disclosure TEXT;
ALTER TABLE memories ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;
ALTER TABLE memories ADD COLUMN decay_weight REAL NOT NULL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN consolidated_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_uri ON memories(uri);
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_node ON memories(node_id);
CREATE INDEX IF NOT EXISTS idx_memories_deprecated ON memories(deprecated);
CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_weight);
CREATE INDEX IF NOT EXISTS idx_memories_hit_count ON memories(hit_count);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at);
```

### 4.5 数据库迁移策略

- 全部使用 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`（带默认值）
- 现有数据和查询零影响
- 先备份 `memory.db`
- 迁移函数在 `db.rs` 的 `initialize()` 中追加执行

---

## 五、Rust 数据结构

### 5.1 Node

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub uri: String,
    pub name: String,
    pub domain: Option<String>,
    pub scope: String,          // "global" | "workspace" | "project" | "session"
    pub node_type: String,      // "concept" | "entity" | "topic" | "skill"
    pub aliases: Vec<String>,   // alias URIs
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}
```

### 5.2 Edge

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub relation: EdgeRelation,
    pub weight: f64,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EdgeRelation {
    DependsOn,
    Implements,
    Supersedes,
    RelatedTo,
    PartOf,
    Triggers,
}
```

### 5.3 Trigger

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trigger {
    pub id: String,
    pub memory_id: String,
    pub trigger_type: TriggerType,
    pub pattern: String,
    pub priority: i32,       // 1-10, higher = more important
    pub enabled: bool,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TriggerType {
    Keyword,       // 精确关键词匹配
    Regex,         // 正则表达式
    UriPrefix,     // URI 前缀匹配
    SessionEvent,  // 会话事件（start/stop/error）
    ToolEvent,     // 工具调用事件（Write/Edit/Bash）
}
```

### 5.4 GlossaryEntry

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlossaryEntry {
    pub id: String,
    pub term: String,
    pub definition: String,
    pub memory_ids: Vec<String>,
    pub domain: Option<String>,
    pub scope: String,
    pub created_at: String,
    pub updated_at: String,
}
```

### 5.5 Snapshot

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub memory_id: String,
    pub version: u32,
    pub title: String,
    pub content: String,
    pub category: Option<String>,
    pub importance: Option<i32>,
    pub tags: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub changed_by: Option<String>,
    pub change_reason: Option<String>,
    pub created_at: String,
}
```

---

## 六、触点层（Touch Layer）

### 6.1 Aho-Corasick 引擎

```rust
// cc-memory/src/touch.rs

use aho_corasick::AhoCorasick;

pub struct TouchLayer {
    /// Aho-Corasick 自动机，从 Glossary + Trigger(Keyword) 构建
    automaton: AhoCorasick,
    /// pattern index → (trigger_type, memory_ids, priority)
    pattern_map: Vec<PatternEntry>,
    /// URI 前缀树
    uri_trie: UriTrie,
}

struct PatternEntry {
    pattern: String,
    source: PatternSource,  // Glossary | Trigger
    memory_ids: Vec<String>,
    priority: i32,
}

enum PatternSource {
    Glossary(String),       // glossary entry id
    Trigger(String),        // trigger id
}
```

### 6.2 触点层生命周期

1. **初始化**：从 SQLite 加载所有 enabled Triggers (Keyword 类型) + Glossary terms → 构建 AhoCorasick
2. **匹配**：`touch.scan(text) -> Vec<MatchResult>` — O(n) 扫描，n = 输入文本长度
3. **刷新**：Trigger/Glossary CRUD 后重建自动机（延迟重建，批量操作合并）

### 6.3 URI 前缀树（Trie）

```rust
pub struct UriTrie {
    root: TrieNode,
}

struct TrieNode {
    children: HashMap<String, TrieNode>,
    node_id: Option<String>,      // 匹配到的 Node ID
    memory_ids: Vec<String>,      // 关联的 Memory IDs
}

impl UriTrie {
    /// 最长前缀匹配
    pub fn lookup(&self, uri: &str) -> Option<TrieLookupResult>;
    /// 前缀范围查询
    pub fn prefix_scan(&self, prefix: &str) -> Vec<TrieLookupResult>;
    /// 插入/更新
    pub fn insert(&mut self, uri: &str, node_id: &str, memory_ids: &[String]);
}
```

---

## 七、MCP Tool 详细设计

### 7.1 现有工具增强

#### memory_add（增强）

新增可选参数：

```json
{
  "uri": "rust://project/error-handling",
  "domain": "rust",
  "node_id": "existing-node-id",
  "triggers": [
    { "type": "Keyword", "pattern": "AppError", "priority": 7 },
    { "type": "Regex", "pattern": "impl\\s+From<\\w+>\\s+for\\s+AppError" }
  ]
}
```

行为：
- 若提供 `uri`，自动解析 `domain` 和 `scope`
- 若提供 `triggers`，创建关联 Trigger 记录
- 若提供 `node_id`，建立 Memory → Node 关联

#### memory_update（增强）

行为变更：
- 更新前自动创建 Snapshot（保存当前版本）
- `version` 字段自增
- 若 Memory 有 Trigger，触点层标记需刷新

#### memory_search（增强）

新增可选参数：

```json
{
  "domain": "rust",
  "scope": "project",
  "uri_prefix": "rust://project/",
  "include_deprecated": false
}
```

行为：
- 先经过触点层 Aho-Corasick 扫描关键词
- 再执行 FTS5 全文搜索
- 结果合并去重，按 (触发优先级 + FTS rank) 综合排序
- 默认排除 `deprecated=true` 的记忆

### 7.2 新增工具

#### memory_recall

**用途**：基于当前上下文的条件触发召回。与 `memory_search` 不同，`recall` 不需要显式搜索词，而是被动匹配。

```json
{
  "name": "memory_recall",
  "description": "基于上下文文本触发条件召回相关记忆。扫描输入文本中的关键词、URI 和事件，返回匹配的记忆。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "context": {
        "type": "string",
        "description": "当前上下文文本（用户消息、文件内容、命令输出等）"
      },
      "event": {
        "type": "string",
        "enum": ["session_start", "session_end", "file_write", "file_edit", "command_run", "error"],
        "description": "可选：当前事件类型，用于匹配 SessionEvent/ToolEvent 类型的 Trigger"
      },
      "uri_context": {
        "type": "string",
        "description": "可选：当前 URI 上下文（如 project://cc-panes/），用于 UriPrefix 匹配"
      },
      "max_results": {
        "type": "integer",
        "default": 5
      }
    },
    "required": ["context"]
  }
}
```

**内部流程**：

```
context text
    ↓
TouchLayer.scan(text)          -- Aho-Corasick 关键词匹配
    ↓
TriggerRegistry.match(event)   -- 事件类型匹配
    ↓
UriTrie.prefix_scan(uri)       -- URI 前缀匹配
    ↓
合并去重 + 综合评分排序
    综合得分 = trigger_priority × 0.4 + decay_weight × 0.3 + (hit_count / max_hit) × 0.3
    ↓
命中更新：hit_count += 1, last_accessed_at = now()
    ↓
加载 Memory 详情
    ↓
返回 Vec<RecallResult>
```

#### memory_graph_query

**用途**：图谱遍历查询，从指定 Node 出发，沿 Edge 探索关联知识。

```json
{
  "name": "memory_graph_query",
  "description": "从指定节点出发遍历知识图谱，返回关联的节点和记忆。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "start_uri": {
        "type": "string",
        "description": "起始节点 URI"
      },
      "direction": {
        "type": "string",
        "enum": ["outgoing", "incoming", "both"],
        "default": "both"
      },
      "max_depth": {
        "type": "integer",
        "default": 2,
        "maximum": 5
      },
      "relations": {
        "type": "array",
        "items": { "type": "string" },
        "description": "可选：过滤关系类型（DependsOn/Implements/Supersedes/RelatedTo/PartOf/Triggers）"
      },
      "include_memories": {
        "type": "boolean",
        "default": true,
        "description": "是否包含节点关联的 Memory 内容"
      }
    },
    "required": ["start_uri"]
  }
}
```

**返回结构**：

```json
{
  "root": { "uri": "...", "name": "..." },
  "nodes": [
    { "uri": "...", "name": "...", "depth": 1, "relation_from_parent": "DependsOn" }
  ],
  "edges": [
    { "source": "...", "target": "...", "relation": "...", "weight": 1.0 }
  ],
  "memories": [
    { "id": "...", "title": "...", "content": "...", "node_uri": "..." }
  ]
}
```

#### memory_link

**用途**：创建/管理 Node 和 Edge，构建知识图谱。

```json
{
  "name": "memory_link",
  "description": "创建知识节点和关系边，构建知识图谱。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["create_node", "create_edge", "delete_node", "delete_edge", "update_node"],
        "description": "操作类型"
      },
      "node": {
        "type": "object",
        "description": "create_node/update_node 时提供",
        "properties": {
          "uri": { "type": "string" },
          "name": { "type": "string" },
          "domain": { "type": "string" },
          "scope": { "type": "string" },
          "node_type": { "type": "string" },
          "aliases": { "type": "array", "items": { "type": "string" } }
        }
      },
      "edge": {
        "type": "object",
        "description": "create_edge/delete_edge 时提供",
        "properties": {
          "source_uri": { "type": "string" },
          "target_uri": { "type": "string" },
          "relation": { "type": "string" },
          "weight": { "type": "number" }
        }
      },
      "node_id": {
        "type": "string",
        "description": "delete_node/update_node 时提供"
      }
    },
    "required": ["action"]
  }
}
```

#### memory_consolidate

**用途**：手动触发睡眠提纯，将 Journal 日志转化为语义记忆。

```json
{
  "name": "memory_consolidate",
  "description": "将 Journal 会话日志提纯为可复用的语义记忆。从情景记忆中提取正确决策、发现的模式和教训。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "journal_path": {
        "type": "string",
        "description": "Journal 文件路径（如 journal-2024-01-15.md），不提供则处理所有未提纯的 Journal"
      },
      "domain": {
        "type": "string",
        "description": "可选：限定提纯的领域"
      },
      "dry_run": {
        "type": "boolean",
        "default": false,
        "description": "预览模式：只返回将要创建的 Memory，不实际写入"
      }
    }
  }
}
```

#### memory_glossary

**用途**：术语表 CRUD + 文本扫描。

```json
{
  "name": "memory_glossary",
  "description": "管理术语表：添加/查询/删除术语，或扫描文本识别已知术语。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["add", "search", "delete", "scan"],
        "description": "操作类型"
      },
      "term": {
        "type": "string",
        "description": "add/delete 时提供术语名"
      },
      "definition": {
        "type": "string",
        "description": "add 时提供定义"
      },
      "memory_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "add 时关联的 Memory ID 列表"
      },
      "domain": {
        "type": "string",
        "description": "add/search 时限定领域"
      },
      "text": {
        "type": "string",
        "description": "scan 时提供的文本，识别其中包含的已知术语"
      },
      "query": {
        "type": "string",
        "description": "search 时的搜索关键词"
      }
    },
    "required": ["action"]
  }
}
```

---

## 八、Hook 集成方案

### 8.1 现有 Hook 增强

#### session-inject（SessionStart）

增强 `load_memory_context()` 逻辑：

```
1. 读取 workflow.md
2. TouchLayer.scan(workflow_content)  -- 扫描关键词
3. memory_recall(context=workflow_content, event="session_start")
4. 将匹配的 Memory 注入 session context
```

#### plan-archive（PostToolUse）

保持不变。

### 8.2 新增 Hook

#### context-snapshot

| 属性 | 值 |
|------|-----|
| 事件 | PostToolUse (Write/Edit) |
| 行为 | 从 stdin 读取 hook JSON，提取文件修改上下文，创建 `fact` Memory |
| 频率控制 | 同 session 同文件去重，5min 内 ≤10 条 |

**Hook 定义**：

```rust
HookDef {
    name: "context-snapshot",
    command: "context-snapshot",
    event: "PostToolUse",
    description: "Capture file modification context as memory",
    tool_filter: Some(vec!["Write", "Edit"]),
    matcher_type: "tool_name",
    match_pattern: "Write|Edit",
}
```

**实现逻辑**：

```
stdin (hook JSON)
    ↓ 解析 tool_name, file_path, content_preview
    ↓
去重检查：same session + same file + within 5 min → skip
    ↓
memory_add({
    title: "Context: {file_path}",
    content: "Modified {file_path}: {content_preview}",
    category: "fact",
    importance: 2,
    scope: "session",
    tags: ["auto-capture", "context-snapshot"]
})
```

#### stop-snapshot

| 属性 | 值 |
|------|-----|
| 事件 | Stop/ESC |
| 行为 | 读取当前 Plan 文件，拍摄"现场快照"存为 `plan` Memory |
| 频率控制 | 每次 Stop 最多 1 条 |

**Hook 定义**：

```rust
HookDef {
    name: "stop-snapshot",
    command: "stop-snapshot",
    event: "Stop",
    description: "Capture current session state as memory on stop",
    tool_filter: None,
    matcher_type: "event",
    match_pattern: "Stop",
}
```

**实现逻辑**：

```
Stop 事件触发
    ↓
读取当前 plan 文件（如存在）
    ↓
收集当前会话摘要
    ↓
memory_add({
    title: "Session Snapshot: {timestamp}",
    content: "{plan_content}\n\n{session_summary}",
    category: "plan",
    importance: 4,
    scope: "session",
    tags: ["auto-capture", "stop-snapshot", "session-state"]
})
```

### 8.3 Hook 注册

在 `src-tauri/src/services/hooks_service.rs` 的 `HOOK_DEFS` 中追加：

```rust
// 新增 Hook 定义
HookDef::new("context-snapshot", "context-snapshot", HookEvent::PostToolUse)
    .with_description("Capture file modification context as memory")
    .with_tool_filter(vec!["Write", "Edit"]),

HookDef::new("stop-snapshot", "stop-snapshot", HookEvent::Stop)
    .with_description("Capture current session state as memory on stop"),
```

---

## 九、睡眠提纯引擎

### 9.1 概念映射

| 人类大脑 | CC-Panes | 说明 |
|---------|----------|------|
| 情景记忆 | Journal 会话日志 | "今天发生了什么" |
| 工作记忆 | Session Memory | 当前会话临时上下文 |
| 语义记忆 | Project/Global Memory | 提炼后的可复用知识 |
| 睡眠巩固 | 提纯引擎 | Journal → Memory 转化 |

### 9.2 提纯流程

```
Journal (journal-*.md)
    ↓ 读取未处理条目
Consolidation Engine (LLM 调用)
    ├── 剔除：试错过程、失败尝试
    ├── 提取：正确决策、发现的模式
    ├── 合并：相似经验归纳
    └── 关联：与已有 Node 建立 Edge
    ↓
Semantic Memory (category: lesson/pattern/decision)
```

### 9.3 触发时机

1. **手动**：`memory_consolidate` MCP tool
2. **定时**：应用空闲 30 分钟后
3. **会话结束后**：Journal 记录完成后标记"待提纯"
4. **前端按钮**：HomeDashboard "整理记忆"

### 9.4 LLM 调用

使用现有 Provider 系统获取 API 配置。

**Prompt 设计**：

```
你是 CC-Panes 的记忆提纯引擎。请分析以下 Journal 会话日志，提取可复用的经验知识。

规则：
1. 只提取最终正确的经验，排除中间的试错过程和失败尝试
2. 使用第一人称叙述（"我发现..."、"下次应该..."）
3. 为每条记忆设计 2-5 个触发关键词（用户输入这些词时应想起这条经验）
4. 分类为 lesson（教训）、pattern（模式）、decision（决策）
5. 设置重要性 1-5（5 最重要）
6. 检查是否与现有 Memory 重复，如重复则建议合并
7. 【费曼测试】对每条提取的经验，用一句大白话概括其核心逻辑。
   如果无法用一句话概括 → 说明逻辑链路不完整 → 标记 feynman_pass: false，原样保留原始日记不入库。
   如果概括成功 → feynman_pass: true，将这句白话摘要存入 consolidated_summary 字段。

现有 Memory 列表（去重参考）：
{existing_memories}

Journal 内容：
{journal_content}

请输出 JSON 数组：
[
  {
    "title": "...",
    "content": "...",
    "category": "lesson|pattern|decision",
    "importance": 1-5,
    "domain": "...",
    "triggers": ["keyword1", "keyword2"],
    "related_memory_ids": ["existing-id-if-similar"],
    "merge_suggestion": "如果与现有记忆重复，建议如何合并",
    "feynman_pass": true,
    "consolidated_summary": "一句话白话摘要（feynman_pass 为 true 时必填）"
  }
]
```

### 9.5 提纯结果处理

```rust
async fn process_consolidation_results(
    results: Vec<ConsolidationResult>,
    service: &MemoryService,
) -> AppResult<ConsolidationReport> {
    let mut report = ConsolidationReport::new();

    for result in results {
        // 费曼白话测试过滤
        if !result.feynman_pass {
            report.feynman_rejected += 1;
            continue; // 跳过未通过白话测试的条目
        }

        if let Some(merge_target) = result.related_memory_ids.first() {
            // 合并到现有 Memory
            let existing = service.get(merge_target).await?;
            service.update(merge_target, UpdateMemory {
                content: Some(merge_content(&existing.content, &result.content)),
                ..Default::default()
            }).await?;
            report.merged += 1;
        } else {
            // 创建新 Memory
            let memory_id = service.add(NewMemory {
                title: result.title,
                content: result.content,
                category: result.category,
                importance: result.importance,
                domain: Some(result.domain),
                tags: result.triggers.clone(),
                ..Default::default()
            }).await?;

            // 创建关联 Triggers
            for keyword in &result.triggers {
                service.create_trigger(NewTrigger {
                    memory_id: memory_id.clone(),
                    trigger_type: TriggerType::Keyword,
                    pattern: keyword.clone(),
                    priority: result.importance,
                }).await?;
            }

            report.created += 1;
        }
    }

    Ok(report)
}
```

### 9.6 Journal 标记

提纯完成后，在 Journal 文件末尾追加标记：

```markdown
<!-- consolidated: 2024-01-15T10:30:00Z, memories_created: 3, memories_merged: 1 -->
```

后续提纯时跳过已标记的 Journal 文件。

### 9.7 组块化巡检（Chunking Inspector）

将零散的短经验自动打包为高层知识组块，模拟人类专家的"组块化学习"能力。

**触发时机**：

- 每周五晚（定时任务）
- 应用空闲 2 小时后
- 手动触发（前端按钮 / MCP tool）

**巡检流程**：

```
扫描本周新增 Memory（category: lesson/pattern/decision）
    ↓
LLM 分析关联性（Prompt 要求识别共性主题）
    ↓
输出组块建议：
  { "chunk_name": "Tauri IPC 错误处理模式",
    "member_ids": ["mem-1", "mem-3", "mem-7"],
    "summary": "..." }
    ↓
自动创建父节点 Node（node_type: "chunk"）
    ↓
创建 PartOf Edge：member → chunk_node
    ↓
更新报告：本周组块化 N 条经验为 M 个知识组块
```

**LLM Prompt**：

```
你是 CC-Panes 的知识组织引擎。以下是最近新增的 N 条经验记忆。
请识别其中的共性主题，将相关经验打包为"知识组块"。

规则：
1. 每个组块至少包含 2 条经验，最多 10 条
2. 同一条经验可以属于多个组块
3. 为每个组块提供一个简洁的名称和一句话摘要
4. 如果某条经验不属于任何组块，跳过即可

经验列表：
{memories_json}

请输出 JSON 数组：
[
  {
    "chunk_name": "组块名称",
    "member_ids": ["mem-id-1", "mem-id-2"],
    "summary": "一句话概括这个知识组块的核心主题",
    "domain": "领域标识"
  }
]
```

---

## 十、版本控制

### 10.1 自动快照

每次 `memory_update` 调用前：

```rust
async fn update_with_snapshot(
    &self,
    memory_id: &str,
    update: UpdateMemory,
    changed_by: &str,
    change_reason: Option<&str>,
) -> AppResult<Memory> {
    // 1. 获取当前版本
    let current = self.repository.get(memory_id).await?;

    // 2. 创建快照
    self.repository.create_snapshot(Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        memory_id: memory_id.to_string(),
        version: current.version,
        title: current.title.clone(),
        content: current.content.clone(),
        category: current.category.clone(),
        importance: Some(current.importance),
        tags: current.tags.clone(),
        metadata: Some(serde_json::to_value(&current)?),
        changed_by: Some(changed_by.to_string()),
        change_reason: change_reason.map(String::from),
        created_at: chrono::Utc::now().to_rfc3339(),
    }).await?;

    // 3. 执行更新，version + 1
    let mut update = update;
    update.version = Some(current.version + 1);
    self.repository.update(memory_id, update).await
}
```

### 10.2 废弃迁移

```rust
async fn deprecate_memory(
    &self,
    old_id: &str,
    new_id: &str,
    reason: &str,
) -> AppResult<()> {
    // 标记旧 Memory 为 deprecated
    self.repository.update(old_id, UpdateMemory {
        deprecated: Some(true),
        migrated_to: Some(new_id.to_string()),
        ..Default::default()
    }).await?;

    // 重定向 Triggers：旧 Memory 的 Triggers 指向新 Memory
    let triggers = self.repository.get_triggers_by_memory(old_id).await?;
    for trigger in triggers {
        self.repository.update_trigger(&trigger.id, UpdateTrigger {
            memory_id: Some(new_id.to_string()),
            ..Default::default()
        }).await?;
    }

    Ok(())
}
```

### 10.3 版本查询

```rust
/// 获取 Memory 的版本历史
async fn get_version_history(
    &self,
    memory_id: &str,
) -> AppResult<Vec<Snapshot>> {
    self.repository.get_snapshots(memory_id).await
}

/// 回滚到指定版本
async fn rollback_to_version(
    &self,
    memory_id: &str,
    target_version: u32,
) -> AppResult<Memory> {
    let snapshot = self.repository.get_snapshot(memory_id, target_version).await?;

    // 创建当前版本的快照（回滚前备份）
    self.update_with_snapshot(
        memory_id,
        UpdateMemory::from_snapshot(&snapshot),
        "system",
        Some(&format!("Rollback to version {}", target_version)),
    ).await
}
```

---

## 十一、MCP Tool 完整列表

| # | Tool | 说明 | 阶段 | 状态 |
|---|------|------|------|------|
| 1 | `memory_add` | 存储（增强：支持 URI/Trigger） | P0 | 增强 |
| 2 | `memory_search` | 搜索（增强：触点层预过滤） | P1 | 增强 |
| 3 | `memory_update` | 更新（增强：自动创建 Snapshot） | P0 | 增强 |
| 4 | `memory_delete` | 删除（现有） | - | 不变 |
| 5 | `memory_daily_report` | 日报（现有） | - | 不变 |
| 6 | **`memory_recall`** | 基于当前上下文的条件触发召回 | P0 | 新增 |
| 7 | **`memory_graph_query`** | 图谱遍历（Node-Edge，指定深度/方向） | P1 | 新增 |
| 8 | **`memory_link`** | 创建/管理 Node 和 Edge | P1 | 新增 |
| 9 | **`memory_consolidate`** | 手动触发提纯（Journal → Memory） | P2 | 新增 |
| 10 | **`memory_glossary`** | 术语 CRUD + 文本扫描 | P1 | 新增 |

---

## 十二、分期实施

### P0：基础增强（1-2 周）

**目标**：版本控制 + 条件触发召回

- [ ] `memories` 表新增字段（uri, domain, version, deprecated, migrated_to, disclosure）
- [ ] `snapshots` 表 + 自动快照机制
- [ ] `triggers` 表 + 基础 CRUD
- [ ] Memory struct 扩展
- [ ] Trigger struct + TriggerType enum
- [ ] Snapshot struct
- [ ] Repository 层：trigger CRUD + snapshot CRUD
- [ ] Service 层：update_with_snapshot + deprecate_memory
- [ ] `memories` 表新增 `hit_count`, `last_accessed_at`, `decay_weight`, `consolidated_summary` 字段
- [ ] `memory_recall` 命中后自动更新 hit_count / last_accessed_at
- [ ] `memory_recall` tool 实现（基础版：Trigger 关键词匹配）
- [ ] 增强 `memory_add`：支持 uri + triggers 参数
- [ ] 增强 `memory_update`：自动快照
- [ ] 增强 SessionStart hook：Trigger 匹配 workflow.md

### P1：图谱与术语（2-3 周）

**目标**：知识图谱 + 术语系统 + 触点层

- [ ] `nodes` 表 + Node struct + CRUD
- [ ] `edges` 表 + Edge struct + CRUD
- [ ] `glossary` 表 + GlossaryEntry struct + CRUD
- [ ] URI 路由：前缀树实现
- [ ] 触点层：Aho-Corasick 构建 + scan
- [ ] `memory_graph_query` tool
- [ ] `memory_link` tool
- [ ] `memory_glossary` tool
- [ ] 增强 `memory_search`：触点层预过滤 + domain/scope 过滤
- [ ] 增强 `memory_recall`：集成 Aho-Corasick + URI Trie

### P2：睡眠提纯（2-3 周）

**目标**：Journal → Memory 自动提纯

- [ ] 提纯引擎实现（LLM 调用 + Prompt 模板）
- [ ] `memory_consolidate` tool
- [ ] Journal 解析器（提取条目、检查标记）
- [ ] 提纯结果处理（创建/合并 Memory + 关联 Trigger）
- [ ] Hook：`context-snapshot`（PostToolUse Write/Edit）
- [ ] Hook：`stop-snapshot`（Stop 事件）
- [ ] 费曼白话测试集成到提纯 Prompt
- [ ] 提纯结果处理增加 feynman_pass 过滤
- [ ] decay_weight 周期性重算（定时任务）
- [ ] 肌肉记忆固化（pinned）判定
- [ ] 潜意识层：CLI 对话流归档（gzip 压缩 + 按日期存储）
- [ ] 潜意识层：config.toml 配置（retention_days / max_size_mb）
- [ ] 潜意识层：回溯重提纯接口
- [ ] 定时提纯（应用空闲 30 分钟触发）
- [ ] cc-panes-hook 新增 Commands 枚举

### P3：前端可视化（2-3 周）

**目标**：Memory Dashboard 增强

- [ ] 版本历史时间线 + Diff 视图
- [ ] 图谱可视化（D3.js / vis-network）
- [ ] Glossary 管理界面
- [ ] Trigger 管理界面
- [ ] 组块化巡检机制实现
- [ ] Memory Dashboard 统计增强
- [ ] Memory Dashboard 展示 hit_count / decay_weight 热力图
- [ ] 提纯状态面板（Journal 提纯进度）
- [ ] 潜意识层：空间管理 + 过期清理 UI

---

## 十三、关键文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `cc-memory/src/db.rs` | 扩展 | 新表 Schema（nodes, edges, triggers, glossary, snapshots）+ memories 迁移 |
| `cc-memory/src/models.rs` | 扩展 | Memory 新字段 + Node/Edge/Trigger/Glossary/Snapshot 结构体 |
| `cc-memory/src/repository.rs` | 扩展 | 新实体 CRUD + 图谱遍历查询 + 快照管理 |
| `cc-memory/src/service.rs` | 扩展 | update_with_snapshot + graph_query + consolidate |
| `cc-memory/src/touch.rs` | 新建 | Aho-Corasick 触点层 + URI Trie |
| `cc-memory/src/consolidation.rs` | 新建 | 睡眠提纯引擎 |
| `cc-memory/Cargo.toml` | 扩展 | 新增 `aho-corasick = "1.1"` 依赖 |
| `cc-memory-mcp/src/handler.rs` | 扩展 | 5 个新 tool 定义和处理 |
| `cc-panes-hook/src/main.rs` | 扩展 | 新 Commands 枚举（context-snapshot, stop-snapshot） |
| `src-tauri/src/services/hooks_service.rs` | 扩展 | HOOK_DEFS 追加新 Hook 定义 |

---

## 十四、技术依赖

**Rust 新增**：

| Crate | 版本 | 用途 |
|-------|------|------|
| `aho-corasick` | `1.1` | 多模式字符串匹配（触点层） |

**前端新增（P3）**：

| Package | 用途 |
|---------|------|
| `vis-network` | 图谱可视化（可选） |

**复用现有**：rusqlite, serde_json, uuid, axum, rmcp, chrono

---

## 十五、验证方式

### 单元测试

```bash
# 所有现有测试不回退
cargo test --workspace
```

### MCP Server 测试

```bash
# CLI 模式测试
cc-memory search "test query"

# stdio JSON-RPC 测试
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_recall","arguments":{"context":"deploy to production"}},"id":1}' | cc-memory-mcp
```

### 手动验证

1. 创建带 URI/Trigger 的 Memory → `memory_recall` 确认触发
2. `memory_update` → 确认 Snapshot 自动生成
3. `memory_link` 创建 Node + Edge → `memory_graph_query` 遍历确认
4. `memory_glossary` 添加术语 → scan 文本确认匹配

### Hook 验证

1. 启用 `context-snapshot` Hook
2. 执行文件编辑操作
3. 确认自动创建 context-snapshot Memory
4. 确认 5 分钟内同文件去重

### 提纯验证

1. 写入 Journal 测试条目
2. 调用 `memory_consolidate`（dry_run=true 预览）
3. 正式执行提纯
4. 确认提取出正确的 lesson/pattern Memory
5. 确认 Journal 文件标记"已提纯"

---

## 十六、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 数据库迁移破坏现有数据 | 高 | ALTER TABLE ADD COLUMN 带默认值；迁移前自动备份 |
| Aho-Corasick 内存占用过大 | 中 | 限制 Glossary + Trigger 总量（上限 10000 条）；延迟构建 |
| LLM 提纯调用成本 | 中 | 使用 Haiku 模型；限制单次提纯 Journal 大小；dry_run 预览 |
| 触点层误触发过多 | 低 | priority 分级；enable/disable 开关；同 session 去重 |
| 图谱查询性能 | 低 | max_depth 限制（≤5）；索引优化；结果缓存 |
