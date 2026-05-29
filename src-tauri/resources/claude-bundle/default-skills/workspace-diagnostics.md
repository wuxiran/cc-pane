---
name: ccpanes-workspace-diagnostics
description: Diagnose CC-Panes workspace storage, workspace.json, projects.csv, data directory routing, and legacy workspace file issues. Prefer MCP/UI for mutations; use this skill for read-only inspection and repair planning.
---

# CC-Panes Workspace Diagnostics

参数: $ARGUMENTS

## 原则

优先使用 `ccpanes` MCP 和 CC-Panes UI。这个 skill 只做诊断和修复方案，不默认直接写 `workspace.json` 或删除工作空间。

- 查看工作空间：`ccpanes.list_workspaces` / `ccpanes.get_workspace`
- 扫描项目：`ccpanes.scan_directory`
- 创建和添加项目：`ccpanes.create_workspace` / `ccpanes.add_project_to_workspace`
- 删除工作空间或移除项目：在 CC-Panes UI 中操作

## 数据目录定位

1. 默认路径：`~/.cc-panes/`
2. 若 `~/.cc-panes/config.toml` 存在且包含 `data_dir`，以配置值为准
3. 工作空间根目录：`<data_dir>/workspaces/`

```bash
if [ -f ~/.cc-panes/config.toml ]; then
  DATA_DIR=$(grep '^data_dir' ~/.cc-panes/config.toml | sed 's/.*=\s*"\(.*\)"/\1/')
fi
DATA_DIR="${DATA_DIR:-$HOME/.cc-panes}"
WS_ROOT="$DATA_DIR/workspaces"
printf 'DATA_DIR=%s\nWS_ROOT=%s\n' "$DATA_DIR" "$WS_ROOT"
```

Windows 上用 PowerShell 检查等效路径。

## 文件结构

```text
<WS_ROOT>/<workspace-name>/
├── workspace.json
└── .ccpanes/
```

若 `workspace.path` 有值，工作空间根目录还可能包含：

```text
<workspace.path>/
├── .ccpanes/
│   └── projects.csv
└── CLAUDE.md
```

## workspace.json 关键字段

字段使用 camelCase：

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

`projects` 条目：

```json
{
  "id": "<uuid-v4>",
  "path": "<absolute-path>",
  "alias": null
}
```

## 诊断流程

### 1. MCP 视角

- `list_workspaces`：确认 UI/后端看到的工作空间
- `get_workspace(workspaceName)`：确认项目列表、路径、隐藏/固定状态
- `list_projects`：确认当前 MCP 可启动的项目路径原样字符串

### 2. 文件系统视角

只读检查：

```bash
find "$WS_ROOT" -maxdepth 2 -name workspace.json -print
```

逐个检查：

- JSON 是否可解析
- `name` 是否与目录名一致
- `projects[].path` 是否为绝对路径
- 项目路径是否存在
- `workspace.path` 是否存在
- 若有 `projects.csv`，是否与 `workspace.json` 项目列表明显不一致

### 3. 常见问题

| 现象 | 可能原因 | 建议 |
|---|---|---|
| UI 里找不到工作空间 | data_dir 指向另一套目录 | 先确认 `config.toml` 和实际 `DATA_DIR` |
| `launch_task` 找不到项目 | 项目未登记或 Windows/WSL 路径不一致 | 用 `list_projects` 取原样路径，必要时 `add_project_to_workspace` |
| workspace 看起来有项目但启动失败 | path 是旧盘符/旧 WSL UNC | 用 MCP 重新添加当前真实路径 |
| `.ccpanes/projects.csv` 和 UI 不一致 | 文件缓存或旧迁移遗留 | 以 MCP/UI 结果为准，制定修复计划 |
| 删除后又出现 | 仍在另一个 data_dir 或 session recovery | 查 data_dir、运行实例、启动历史 |

## 输出格式

汇报时给出：

1. 当前 data_dir 和 workspaces 路径
2. MCP 看到的工作空间/项目
3. 文件系统发现的异常
4. 明确区分“可通过 MCP 修复”“需要 UI 操作”“不要自动删除”的项
