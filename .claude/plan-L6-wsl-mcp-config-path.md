# L6 · 修复 WSL 启动 Claude 时 MCP config 路径拼接错误

> 独立缺陷修复线，与发现性计划（docs/67）无关，单独提交。
> 本 plan 由 leader 派发，worker 在独立 worktree 中执行。

## 复现（leader 实测，2026-07-27）

环境：Windows 11 宿主，工作空间 `cc-book` 的 `defaultEnvironment` 为 wsl。

调用（经 orchestrator MCP）：
```
launch_task(
  projectPath   = "D:\04_workspace_rust\cc-book",
  workspaceName = "cc-book",
  cliTool       = "claude",
  // 未传 runtimeKind，走 workspace 默认
)
```

返回：
```json
{"runtimeKind":"wsl","runtimeSource":"workspace_default",
 "sessionId":"be317953-fd5f-4fd5-8732-69297a883c46","status":"launching"}
```

会话随即 `exited`。`get_session_output` 拿到的全部输出只有两行：

```
Error: Invalid MCP configuration:
MCP config file not found: D:\mnt\c\Users\wuxiran\.cc-panes\wsl-claude-mcp-be317953-fd5f-4fd5-8732-69297a883c46.json
```

对照：同一 `projectPath` 显式传 `runtimeKind="local"` 启动**正常**
（session `965c1296-...` 与 `8c3d05b2-...` 均正常起来并进入 active）。

## 症状分析（leader 的初步判断，worker 需自行核实）

报错路径 `D:\mnt\c\Users\wuxiran\.cc-panes\...` 的形状说明：
WSL 侧的绝对路径 `/mnt/c/Users/wuxiran/.cc-panes/...` 被当成**相对路径**，
拼接到了某个 Windows 基准目录（`D:\`）之后。

即：某处做了「Windows 路径 → WSL 路径」的转换得到 `/mnt/c/...`，
但把结果交给了一个仍按 Windows 语义 join 的调用方；
或反过来，转换后的路径又被二次 join。

**这只是方向性猜测，不要当结论。** 请自行定位真实调用链后再动手。

## 影响面

工作空间 `defaultEnvironment = wsl` 时，**经 MCP `launch_task` 派 Claude worker 全部启动失败**。
这条路径正是无人值守派工的主干（CLAUDE.md 记录 CC-Panes 的核心场景就是长时派工），
且失败形态是「launch_task 返回 status=launching 看着成功、会话随即 exited」——
调用方若只看返回值不查状态，会误判为派工成功。

注意：`.cc-panes`（非 `-dev`）说明**这是 release 数据目录**，即安装版同样中招。

## 定位起点

- MCP config 文件名形如 `wsl-claude-mcp-<sessionId>.json`，全仓库搜这个前缀或其
  格式化模板，能直接找到生成处。
- CLAUDE.md 记录相关背景：`terminal_service.rs:1606-1620` 一带负责注入
  `CC_PANES_API_PORT/TOKEN/BASE_URL` 并生成 `mcp-<sessionId>.json`；
  WSL 分支可能是另一处或同处的分叉。
- 项目路径的跨形式等价逻辑见 `canonical_project_path` / `projectIdentityKey`
  （CLAUDE.md 明写：判断路径必须先过它们，直接 `Path::exists()` 会误判）。
  修复时注意不要绕过既有的规范化入口另造一套。

## 要求

1. **先定位再修**。给出真实调用链（文件:行号），说明 Windows 路径与 WSL 路径
   在哪一步混用，再动手。
2. **修根因，不要在报错处打补丁**。不要用「检测到 `D:\mnt\` 前缀就替换」这种字符串修补。
3. **两侧都要对**：写入 config 文件的路径与传给 CLI 的 `--mcp-config` 参数路径，
   必须分别使用各自语境正确的形式（宿主侧写文件用 Windows 路径，
   传给 WSL 内进程的参数用 `/mnt/...` 形式）。这两者不是同一个字符串。
4. **SSH 运行时**：`runtimeKind` 还有 `ssh`。检查它是否有同源问题；
   有就一并修，没有就在上报里说明你确认过。

## 验收

### 必须实测复现与修复

修完后必须真实跑一次 WSL 启动验证，不能只靠单元测试。验证方式：
在你的 worktree 里改完并构建后，说明你**怎么验证的**、观察到什么。

> 注意 CLAUDE.md 的暗雷：`tauri dev` **不重建 external binaries**
> （daemon/web/cli-hook）。若你的改动落在 `cc-panes-daemon` 或
> `cc-cli-adapters` 里，主程序热重编也不会生效——会话启动走的还是
> `<target-dir>\debug\binaries\` 里的旧二进制，出现「测试全绿却不生效」。
> 这种情况必须 `cargo build -p cc-panes-daemon` 并拷贝到该目录。
> 又：运行中的 exe 无法覆盖但**可以改名**——先把旧 exe 改名再拷新的，
> 不必杀掉用户正在跑的实例。

### 必跑命令

```
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

若改动涉及前端，另跑 `npx tsc --noEmit` 与 `npm run test:run`。

**禁止用 `| tail`**。CLAUDE.md 明写管道退出码取自最后一个命令，
`tail` 永远成功，会把失败报成通过——0.11.2 合并期实测据此误报过一次「clippy 全绿」。
判定必须看真实退出码。

### 回归测试

补一个测试锁住这个行为：给定 WSL runtimeKind 与 Windows 项目路径，
生成的 config 文件路径与传给 CLI 的参数路径各自是正确形式。

## 边界（不要做）

- 不要顺手重构 runtime/路径体系。只修这一个缺陷。
- 不要改 `launch_task` 的 MCP 接口签名。
- 不要动发现性相关的任何文件（README、docs/67、web/components/tips/）——
  那些正由其它 worker 并行处理。
- 不要提交 git，除非 leader 明确指示。

## 收尾

按 docs/65 观测契约上报。必须包含：
真实调用链（文件:行号）、根因一句话、改了哪些文件、
三条 cargo 命令的**真实退出码**、你如何实测验证 WSL 启动已恢复、
SSH 运行时的核查结论。
