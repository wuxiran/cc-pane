---
name: ccpanes-cursor-handoff
description: >
  Hand off work from {{app_name}} to Cursor IDE (open project/worktree, write handoff
  file, optional prompt deeplink), dispatch Cursor Agent CLI, or use cursor_bridge
  (init/context/do/status) for bounded CLI sessions. Use when the user says
  "打开 Cursor"、"丢给 Cursor"、"在 Cursor 里继续"、"Cursor 联动"、"CCE"、
  "open in Cursor"、"handoff to Cursor"、"Cursor IDE"、"compose 预填". Not for
  patching Cursor binaries, Sand scripts, or CDP/remote-debugging-port.
---

# Cursor 联动（handoff）

参数: $ARGUMENTS

把当前任务从 {{app_name}} **交接**到 Cursor。默认走 **IDE 工位**；需要无人值守编排时走 **Cursor Agent CLI**。

## 角色（先选对）

| 角色 | 是什么 | 本 skill 用法 |
|------|--------|----------------|
| **Cursor IDE** | 桌面编辑器 + Agents/Composer | 打开正确 path + handoff 文件 +（可选）deeplink 预填 |
| **Cursor Agent CLI**（`cursor-agent` / `agent`） | 终端 agent，`x-cursor-client-type: cli` | `{{mcp_server_name}}.dispatch_task` / `launch_task`，`cliTool: "cursor"` |
| **Cursor Bridge** | 同一 CLI 的有边界会话（init / context / do） | `{{mcp_server_name}}.cursor_bridge`；不是 CDP，不是 IDE 索引 |
| **CC-Panes** | 多实例编排台 | 真源：项目 path、worktree、binding、plan |

```
磁盘上的同一 project / worktree path
        ▲
        │ 不拷贝、不同步文件树
   ┌────┴────┐
 CC-Panes   Cursor IDE
 (编排)      (深编辑)
```

**不要**：嵌 Cursor 窗口、rsync 两套目录、镜像 chat transcript、改 Cursor 安装目录伪装 Sand、给 Cursor.exe 开 `--remote-debugging-port` 去点 Agents 窗口。

---

## 触发后先问自己

1. 用户要的是 **IDE 里人肉接着改**，**再开一个可编排的 cursor CLI worker**，还是 **只读理解项目 / 有边界的持续会话**？
2. 目标 path 是 **当前 project** 还是某个 **worktree**？（handoff 必须对准 agent 实际在改的那棵树）
3. 要不要 **预填一段 prompt**？（会 **新建** New Agent 标签，不会填进当前已打开的那条）

---

## A. IDE 交接（默认主路径）

### A0. 解析目标 path

优先级：

1. `$ARGUMENTS` 里的显式 path / 项目名  
2. 环境变量 `CC_PANES_PROJECT_PATH`（在 {{app_name}} 管控会话里通常有）  
3. `{{mcp_server_name}}.list_projects` 返回的**登记原样字符串**（WSL/UNC 别自己拼）  
4. 当前 shell `cwd`（仅当确认是仓库根）

Worktree：用 worktree 根，**不要**误开 monorepo 主根却让人改到错树。

Windows 上 Cursor IDE 优先给 **Windows 路径**（`D:\...`）。登记的是 `/mnt/d/...` 或 `\\wsl.localhost\...` 时，先规范成 IDE 能直接打开的形式再 handoff。

### A1. 写 handoff 文件（推荐，几乎总是做）

写入目标仓库（或 worktree）下：

```text
<project>/.ccpanes/.cache/handoff-latest.md
```

若目录不存在就创建。`.ccpanes/.cache/` 是机器本地缓存层（docs/98），已被 `.ccpanes/.gitignore` 忽略，不会进仓库。内容模板：

```md
# CC-Panes → Cursor handoff

- 时间: <ISO 或本地时间>
- 来源会话: $CC_PANES_PTY_SESSION_ID / launchId（有则写）
- 项目 path: <绝对路径>
- Worktree: <若有>

## 目标

<一句话要 Cursor 做什么>

## 上下文

- 已完成: ...
- 进行中: ...
- 相关文件: ...
- 禁忌 / 别动: ...

## 建议下一步

1. ...
2. ...

## 参考

- plan / binding / 其它路径（可选）
```

长上下文 **只进这个文件**，不要整段塞进 deeplink URL（长度与确认框都很糟）。

### A2. 打开 Cursor 到该 path

只开工程、复用已有窗口（有 `cursor` CLI 时）：

```bash
# Windows / macOS / 通用（cursor 在 PATH 上）
cursor --reuse-window "<绝对 path>"
```

找不到 `cursor` 时：

- Windows 常见：`%LOCALAPPDATA%\Programs\cursor\Cursor.exe` 或安装目录下的 `Cursor.exe`
- macOS：`/Applications/Cursor.app` → `open -a Cursor "<path>"`

可选：打开到行

```bash
cursor --reuse-window -g "<file>:<line>"
```

**不要**在已打开同一工程时无 `cursor --new-window`，除非用户明确要第二窗。

### A3. （可选）预填 Agents 输入框 — 会新建 Agent

仅当用户明确要「把话递进 Cursor 输入框 / 新开一条 Agent 任务」时使用。

#### 铁律（本机 Cursor 3.17+ 源码级行为）

| 事实 | 含义 |
|------|------|
| deeplink 调 `deeplink.prompt.prefill` | 文案即 **"Create a new chat with the following prompt"** |
| Glass：`newAgentRequested` + `pendingPrompt` | **每次新建 New Agent 标签** |
| 经典：`createComposer({ openInNewTab: true })` | 同样新建 tab |
| **没有** `reuse` / `targetDraftId` / 填当前 Composer 的公开参数 | 做不到「只改当前输入框」 |
| 可能弹出 **Create Chat** 确认框 | 需用户点一次 |

因此：

- 测 3 次 deeplink = 3 个 New Agent（正常，不是 bug）
- 日常交接 **优先 A1 handoff + 用户在已有 Agent 里 `@handoff-latest.md`**，少打 deeplink

#### 正确调用方式（只发一次，禁止叠枪）

协议注册等价于：

```text
Cursor.exe --open-url -- "cursor://anysphere.cursor-deeplink/prompt?text=<URL编码>"
```

**只允许下面之一**，禁止组合：

1. ~~`cursor --reuse-window path`~~ + ~~`Start-Process uri`~~ + ~~`cursor uri`~~ → 会多窗 / 多标签  
2. **正确**：若窗口已在目标工程 → **仅** `--open-url` 一次  
3. 若还没打开工程 → 先 A2 **一次**，等窗口起来后再 **仅** `--open-url` 一次（或让用户自己 @handoff）

PowerShell 示例：

```powershell
$exe = (Get-Command cursor -ErrorAction SilentlyContinue)?.Source
# 若 cursor.cmd 只是 wrapper，协议仍走已注册的 Cursor.exe --open-url
$text = Get-Content -Raw "<project>\.ccpanes\.cache\handoff-latest.md"
# deeplink 宜短：用引用，不要整文件
$short = @"
请阅读并执行：.ccpanes/.cache/handoff-latest.md
$($ARGUMENTS 里的一句话目标)
"@
$uri = "cursor://anysphere.cursor-deeplink/prompt?text=$([uri]::EscapeDataString($short))"
# 解析真正的 Cursor.exe（与 HKCU\Software\Classes\cursor\shell\open\command 一致）
$cursorExe = "I:\cursor\Cursor.exe"  # 按本机安装修改；或从注册表读
Start-Process -FilePath $cursorExe -ArgumentList @('--open-url','--', $uri)
```

解析 `Cursor.exe`（Windows）：

```powershell
$cmd = (Get-ItemProperty -Path 'HKCU:\Software\Classes\cursor\shell\open\command').'(default)'
# 形如: "I:\cursor\Cursor.exe" --open-url -- "%1"
```

macOS：`open 'cursor://anysphere.cursor-deeplink/prompt?text=...'`（依赖已注册 URL scheme）。

可选 query（次要）：

- `mode` — agent/plan 等 unified mode（**仍新建 chat**）
- `workspace` — 按工作区名路由窗口（Glass 下可能被忽略）

### A4. 向用户交代

明确说：

- 已打开的 path  
- handoff 文件路径  
- 是否发了 deeplink（并警告：**会多一个 New Agent**，需确认框时请点 Create Chat）  
- 建议在 Cursor 里 `@.ccpanes/.cache/handoff-latest.md` 继续  

---

## B. Cursor Agent CLI 编排（无人值守 / 多实例）

当用户要的是 **可 dispatch 的 worker**，不是 IDE：

```
{{mcp_server_name}}.dispatch_task 或 launch_task
  projectPath: <登记路径>
  cliTool: "cursor"
  prompt: <短引用 handoff 文件>
  runtimeKind / title / ...
```

要点：

- CLI 身份是 **`cli`**，与 IDE deeplink / Sand 补丁 **无关**  
- resume：`list_resume_sessions(cliTool="cursor")` 或 launch_history（扫 `~/.cursor/chats`）  
- MCP：启动时写入用户级 `~/.cursor/mcp.json` 的 ccpanes entry（多并发最后一次覆盖）  
- print worker：`adapterOptions.print` → `-p --output-format text`  
- 详细启动/卡住/resume 见 [`launch-task`](launch-task.md) / [`dispatch-task`](dispatch-task.md)

**不要**指望装了 IDE Sand 脚本就让 CLI 变 Sand。

---

## B2. Cursor Bridge MCP（有边界 CLI 会话）

走官方 `cursor-agent`，**不是** Vanyangyang/cursor-bridge 的 CDP。需要 `ccpanes` MCP。

登记簿（会话 / 模型默认 / 默认项目）**按 CC-Panes 工作空间**存放。你在 {{app_name}} 管控会话里时，
工作空间和项目会从调用方自动推断，**不需要 `init`**；直接 `context` / `do` 即可。
只有在 {{app_name}} 之外调用、或想切到别的工作空间 / 项目时才绑定一次：

```text
{{mcp_server_name}}.cursor_bridge(action="init", workspaceName="<工作空间>")            # 只绑工作空间
{{mcp_server_name}}.cursor_bridge(action="init", projectPath=<登记绝对路径>)            # 顺带设默认项目（工作空间由项目推出）
```

每个 action 都接受 `workspaceName` / `projectPath` 做一次性覆盖。项目取值顺序：显式 `projectPath` → 调用方自己的项目 → `init` 设的默认 → 工作空间第一个项目。

| 意图 | 调用 |
|------|------|
| 陌生仓库语义问题（所有权 / 调用链 / 数据流） | `action="context", query="..."` — print + `--mode ask`；默认阻塞到 worker 退出，`evidence.text` 就是证据块（`evidence.structured=false` 表示模型没按格式答，给的是原始输出）；`complete=false` 是超时，可拿 `ptySessionId` 再 `wait_for_session`。传 `wait=false` 只要回执 |
| 有边界的执行 | `action="do", task="...", readOnly=true` 或 `allowedPaths=[...]` |
| 持续同一 Cursor 会话 | `sessionMode="create"` 记下 `sessionId`；下一回合 `sessionMode="continue", sessionId=...` 并**重申** readOnly 或 allowedPaths 子集 |
| 查状态 / 改模型默认 | `action="status"` / `action="model"` |
| 结束连续性（不杀 PTY） | `action="session", sessionAction="close"`；forget/abandon 必须 `confirm=true` |

已知文件读取、测试、git、文档仍用本地工具。context 用的是 CLI 的代码理解，**不是** Cursor IDE 索引。allowedPaths 是 prompt 边界，不是 OS 沙箱；主 agent 必须自己核 diff。

取消活任务用 `kill_session`，不要猜点 Stop。

---

## C. 决策表

| 用户意图 | 走哪条 |
|----------|--------|
| 「在 Cursor 打开这个项目」 | A2 only |
| 「把上下文给 Cursor 接着改」 | A1 + A2（默认） |
| 「预填到输入框」 | A1 + A2 + A3（告知会新建 Agent） |
| 「开个 Cursor agent 帮我跑任务」 | B（CLI）或 B2 `do` |
| 「这仓库谁管这段状态 / 调用链」 | B2 `context` |
| 「跟 Cursor 同步工作空间」 | **不同步文件**；A2 打开同一 path；多项目则打开当前 project 或生成 multi-root 由用户另说 |
| 「填进我现在这条 Compose」 | **做不到**（公开 API）；改 A1 + 手动 @ |

---

## 反模式

- ❌ 连续多次 deeplink「试试」→ New Agent 刷屏  
- ❌ `Start-Process uri` 又 `cursor uri` 又 `cursor path` 叠三枪 → 第二窗 / 乱标签  
- ❌ 把整份 transcript 塞进 `text=`  
- ❌ 用 Sand / 魔改 Cursor 安装目录当「联动」  
- ❌ 对 CLI 会话发 IDE deeplink，或对 IDE 以为 client-type 会变成 cli  
- ❌ handoff 写到错误 worktree  
- ❌ WSL 路径未规范就丢给 Windows Cursor  
- ❌ 在 {{app_name}} 里嵌 Cursor 或伪造 tabId  
- ❌ CDP / `--remote-debugging-port` / 点 Agents DOM 当「CCE」  

---

## 本机核验摘要（实现依据，防回归时臆造）

实测 Cursor 桌面 **3.17.x**：

- `cursor --help`：有 `--chat`（独立 chat 窗）、`agent` 子命令；**无** `cursor --prompt "..."` 填当前对话  
- 协议：`HKCU\...\cursor\shell\open\command` = `Cursor.exe --open-url -- "%1"`  
- `workbench.*.main.js` 中 `deeplink.prompt.prefill`：**确认框 Create Chat** → Glass `newAgentRequested` 或 `createComposer(openInNewTab:!0)`  
- CLI `index.js`：`x-cursor-client-type` 为 **`cli`**，与 IDE `ide`/`sand` 分离  

版本升级后若行为变了，以本机 `workbench.glass.main.js` 里该 handler 为准，并更新本 skill。

---

## 示例

```
/ccpanes:cursor-handoff
/ccpanes:cursor-handoff 打开当前项目
/ccpanes:cursor-handoff 把重构登录的上下文丢给 Cursor
/ccpanes:cursor-handoff path=D:\work\foo worktree 预填：按 handoff 继续
/ccpanes:cursor-handoff cli 派一个 cursor worker 跑测试
/ccpanes:cursor-handoff 用 cursor_bridge context 查 pane 状态所有权
```
