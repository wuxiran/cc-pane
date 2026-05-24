---
name: ccpanes-organize-workspace
description: Audit and organize {{app_name}} workspace folders without data loss. Use when the user says "整理工作空间"、"清理 workspace"、"workspace cleanup"、"把临时文件放垃圾箱"、"归档工作区"、"整理项目目录". The skill creates a reviewable plan first, skips single-project source repositories by default, and moves uncertain files only into `_trash/` instead of deleting them.
---

# 整理工作空间

参数: $ARGUMENTS

## 目标

把 workspace 根目录整理成统一结构，同时保护材料不丢失。

统一根目录：

```text
workspace-root/
├── AGENTS.md
├── CLAUDE.md
├── .gitignore
├── .ccpanes/
├── projects/
├── worktrees/
├── docs/
├── ops/
├── evidence/
├── references/
├── scripts/
├── archive/
├── scratch/
└── _trash/
```

`.ccpanes/` 允许：

```text
.ccpanes/
├── config.toml
├── projects.csv
├── layout.json
├── prompts/
├── plans/
├── specs/
├── tasks/
├── snapshots/
├── reports/
├── history/
├── journal/
├── runtime/
└── organize/
```

## 强制安全规则

- 默认只做审计和计划，不移动文件。
- 禁止直接删除文件或目录；待删除材料只能移动到 `_trash/<timestamp>/items/`。
- 单项目源码型 workspace 默认跳过整理。判断信号：projectCount <= 1，根目录包含 `.git/`，或包含明显源码文件如 `package.json`、`Cargo.toml`、`go.mod`、`pom.xml`。
- 不要整理未挂载、路径不存在、metadata-only 的 workspace，只报告原因。
- 不要移动这些路径：`.git/`、`.ccpanes/history/`、`.claude/`、`.codex/`、`.env`、`node_modules/`、`target/`、`dist/`、`.venv/`、`ops/secrets/`、`AGENTS.md`、`CLAUDE.md`。
- 对不确定文件只标记为 `review`，不要自动移动。

## 标准流程

1. **定位 workspace**
   - 未指定名字时调 `{{mcp_server_name}}.list_workspaces`。
   - 指定名字时调 `{{mcp_server_name}}.get_workspace(workspaceName)`。
   - 用户说"全部"时逐个处理，但先只输出汇总计划。

2. **分类**
   - `metadata-only`: path 为空。
   - `missing`: path 不存在或未挂载。
   - `single-project`: 单项目源码型，默认跳过。
   - `coordination`: 协调/文档/运维工作区，通常含 `ops`、`docs`、`.ccpanes`，项目路径多在外部。
   - `asset-ops`: 资产/设备/模型/部署工作区，通常含 `configs`、`deployments`、`logs`、`archive`。
   - `multi-repo`: 根目录下多个 Git repo 或 worktree。
   - `mixed`: 无法归类，保守处理。

3. **浅层审计**
   - 只扫根目录和 `.ccpanes` 一层，必要时最多 `maxdepth=2`。
   - 统计：现有标准目录、非标准顶层目录、根目录散落文件、已有 `_trash`、`.ccpanes` 非白名单项、疑似重复项目路径。
   - 不要对大目录做全量递归。

4. **生成计划**
   - 输出三类动作：
     - `create`: 创建缺失标准目录或 `_trash`。
     - `move_to_trash`: 明确临时/一次性/待删除材料。
     - `review`: 需要用户确认后才移动。
   - 用户没有明确确认前，不执行任何移动。

5. **执行已确认计划**
   - 创建 `_trash/<timestamp>/items/`。
   - 按原相对路径搬入 `items/`，保留目录结构。
   - 写 `_trash/<timestamp>/manifest.md` 和 `manifest.json`，记录原路径、目标路径、原因、时间。
   - 确保 `_trash/` 在 `.gitignore` 中；没有 `.gitignore` 时创建。

6. **回报**
   - 汇总跳过的 workspace、创建的目录、移动到垃圾箱的材料、仍需人工确认的项目。
   - 明确垃圾箱批次路径。

## 垃圾箱结构

```text
_trash/
├── README.md
└── <YYYYMMDD-HHMMSS>/
    ├── manifest.md
    ├── manifest.json
    └── items/
```

`_trash/README.md` 内容要说明：这里是待删除隔离区，不是永久归档；清空前必须人工确认。

## 可自动建议移动到垃圾箱的模式

仅在用户确认后移动：

- 根目录 `tmp*`、`*_tmp*`、`.tmp/`、`scratch` 里的过期一次性材料。
- 根目录 `*.log`、临时 `*.out`、`*.err`，但跳过正式 `logs/` 目录。
- 根目录散落截图和浏览器证据：`*.png`、`*.jpg`、`*.json`、`*.network-response`，优先建议移到 `evidence/`；如果明显是失败尝试或临时调试，再建议 `_trash`。
- `nul`、`devnull`、`tmpclaude-*`、临时打包产物、一次性测试输入。

## 常用命令模板

审计目录时优先用只读命令：

```bash
find "$WORKSPACE" -maxdepth 1 -mindepth 1 -printf '%f\n' | sort
find "$WORKSPACE/.ccpanes" -maxdepth 1 -mindepth 1 -printf '%f\n' | sort
```

移动时必须使用唯一批次目录：

```bash
batch="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORKSPACE/_trash/$batch/items"
```

不要使用 `rm`、`git clean`、`find -delete`、`git reset --hard`。

## 输出格式

先输出计划：

```text
Workspace: <name>
Type: <type>
Decision: audit-only | skip-single-project | ready-for-confirmation

Create:
- <path>

Move to _trash after confirmation:
- <path> -> <reason>

Review manually:
- <path> -> <reason>
```

执行后输出：

```text
Moved batch: <workspace>/_trash/<timestamp>
Manifest: <workspace>/_trash/<timestamp>/manifest.md
Remaining review items: <count>
```
