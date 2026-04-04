# CC-Panes 工作空间管理

通过文件系统操作管理 CC-Panes 工作空间。支持创建、查看、修改、删除工作空间及其项目。

**用法**: `/ccbook:workspace <子命令> [参数]`

参数: $ARGUMENTS

---

## 数据目录定位

1. 默认路径: `~/.cc-panes/`
2. 检查 `~/.cc-panes/config.toml` 中的 `data_dir` 配置项，若存在则使用该值
3. 工作空间根目录: `<data_dir>/workspaces/`

```bash
# 确定 data_dir
if [ -f ~/.cc-panes/config.toml ]; then
  DATA_DIR=$(grep '^data_dir' ~/.cc-panes/config.toml | sed 's/.*=\s*"\(.*\)"/\1/')
fi
DATA_DIR="${DATA_DIR:-$HOME/.cc-panes}"
WS_ROOT="$DATA_DIR/workspaces"
```

在 Windows 上使用 PowerShell 等效操作。

---

## workspace.json 格式

所有字段使用 **camelCase**（与 Rust `#[serde(rename_all = "camelCase")]` 保持一致）:

```json
{
  "id": "<uuid-v4>",
  "name": "<workspace-name>",
  "alias": null,
  "createdAt": "<ISO8601-UTC>",
  "projects": [],
  "providerId": null,
  "path": null,
  "pinned": false,
  "hidden": false,
  "sortOrder": null
}
```

### project 条目格式

```json
{
  "id": "<uuid-v4>",
  "path": "<absolute-path>",
  "alias": null
}
```

---

## 目录结构

```
<WS_ROOT>/<workspace-name>/
├── workspace.json
└── .ccpanes/
```

若 workspace.path 有值:
```
<workspace.path>/
├── .ccpanes/
│   └── projects.csv
└── CLAUDE.md          (仅首次生成，不覆盖)
```

---

## 子命令

根据 `$ARGUMENTS` 解析子命令并执行对应操作。

### `list` — 列出所有工作空间

读取 `<WS_ROOT>/*/workspace.json`，汇总展示:

| 字段 | 说明 |
|------|------|
| name | 工作空间名称 |
| alias | 别名 |
| projects | 项目数量 |
| providerId | 绑定的 Provider |
| pinned | 是否固定 |
| path | 根目录路径 |

按表格或列表格式输出。

### `create <name> [--path <path>]` — 创建工作空间

1. 检查 `<WS_ROOT>/<name>/` 目录是否已存在（不能重名）
2. 创建目录: `<WS_ROOT>/<name>/`
3. 创建子目录: `<WS_ROOT>/<name>/.ccpanes/`
4. 生成 `workspace.json`:
   - `id`: 生成 UUID v4（PowerShell: `[guid]::NewGuid().ToString()`, bash: `uuidgen` 或 `python -c "import uuid; print(uuid.uuid4())"`)
   - `name`: 参数值
   - `createdAt`: 当前时间 ISO8601 UTC 格式
   - 其他字段为默认值
5. 若指定了 `--path`:
   - 设置 `path` 字段
   - 调用 init 逻辑（见 `init` 子命令）

### `show <ws>` — 查看工作空间详情

读取 `<WS_ROOT>/<ws>/workspace.json`，格式化展示所有字段，包括:
- 基本信息（name, alias, id, createdAt）
- 配置（providerId, pinned, hidden, sortOrder）
- 项目列表（id, path, alias）

### `add-project <ws> <path>` — 添加项目

1. 验证 `<path>` 是绝对路径且目录存在
2. 读取 `workspace.json`
3. 检查 projects 数组中是否已有相同 path（去重）
4. 生成新 project 条目（id 为 UUID v4）
5. 追加到 projects 数组
6. 写回 `workspace.json`
7. 若 workspace.path 有值，同步 `projects.csv`

### `remove-project <ws> <project-id>` — 移除项目

1. 读取 `workspace.json`
2. 从 projects 数组中删除匹配 id 的条目
3. 写回 `workspace.json`
4. 若 workspace.path 有值，同步 `projects.csv`

### `set-alias <ws> [alias]` — 设置/清除工作空间别名

1. 读取 `workspace.json`
2. 设置 `alias` 字段（无参数时设为 `null`）
3. 写回

### `set-provider <ws> <provider-id>` — 绑定 Provider

1. 读取 `workspace.json`
2. 设置 `providerId` 字段
3. 写回

### `pin <ws>` / `unpin <ws>` — 固定/取消固定

1. 读取 `workspace.json`
2. 设置 `pinned` 为 `true` 或 `false`
3. 写回

### `init <ws>` — 初始化/修复工作空间

用于补全缺失的目录和文件，**不覆盖已有文件**。

1. 读取 `<WS_ROOT>/<ws>/workspace.json`
2. 检查并补全:
   - `<WS_ROOT>/<ws>/.ccpanes/` 目录
   - 若 `workspace.path` 有值:
     - `<path>/.ccpanes/` 目录
     - `<path>/CLAUDE.md`（模板见下方）
     - `<path>/.ccpanes/projects.csv`（根据 projects 数组生成）
3. 输出修复报告（列出补全了哪些内容）

**CLAUDE.md 模板**:
```markdown
# <workspace-name>

> CC-Panes 管理的工作空间

## 子项目

项目列表见 `.ccpanes/projects.csv`。
```

**projects.csv 格式**:
```csv
path,alias,branch,status
<project-path>,<alias>,<git-branch>,<clean|dirty|unknown>
```

branch 和 status 通过 `git branch --show-current` 和 `git status --porcelain` 获取。

### `delete <ws>` — 删除工作空间

1. 确认操作（向用户确认）
2. 删除整个 `<WS_ROOT>/<ws>/` 目录

---

## 验证规则

- 工作空间名称不能包含 `/`、`\`、`:`、`*`、`?`、`"`、`<`、`>`、`|` 等文件系统非法字符
- 工作空间名称不能重复（目录已存在即为重复）
- 项目路径必须是绝对路径
- 添加项目时按 path 去重
- UUID 使用 v4 格式
- 时间使用 ISO8601 UTC 格式（如 `2024-01-15T08:30:00.000Z`）

---

## 自动同步

修改 workspace.json 后，正在运行的 CC-Panes 应用会通过文件系统监控自动感知变化并刷新 UI，无需手动重启。

---

## MCP 工具调用（推荐）

如果你拥有 `ccpanes` MCP 工具，**优先使用 MCP 而非文件系统操作**。MCP 工具更安全且保证数据一致性。

### 从路径批量导入项目

1. 调用 `ccpanes.scan_directory`（参数: `{ path: "目录路径" }`）→ 获取所有 Git 仓库列表
2. 调用 `ccpanes.create_workspace`（参数: `{ name: "工作空间名", path: "根目录路径" }`）
3. 对扫描结果中的每个仓库，调用 `ccpanes.add_project_to_workspace`（参数: `{ workspaceName: "工作空间名", projectPath: "仓库路径" }`）
4. 可选：调用 `ccpanes.launch_task` 在各项目中启动任务

### 查看工作空间

- 列表：`ccpanes.list_workspaces`
- 详情：`ccpanes.get_workspace`（参数: `{ workspaceName: "名称" }`）

### 注意

- 破坏性操作（删除工作空间/项目）不暴露为 MCP，需在 UI 中手动操作
- MCP 调用会自动同步 UI（通过文件系统监控）

---

## 执行

解析 `$ARGUMENTS`，执行对应子命令。若参数为空或无法识别，展示帮助信息（列出所有子命令及用法）。
