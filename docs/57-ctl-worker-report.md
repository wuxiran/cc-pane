# Worker Report: cc-panes-ctl (0113-ctl)

## 状态

IMPLEMENTED

Phase 0-4 均已实现并各自独立提交。代码与 WSL 可验证项已完成；Windows 桌面、真实 CLI 灰度矩阵和打包 sidecar 仍需 Windows host 验收。

## 提交

- Phase 0: `f264453 refactor(ctl): 抽取并强化端点发现`
- Phase 1: `d08e6e0 feat(ctl): 实现通用 MCP 工具调用`
- Phase 2: `60e5e22 feat(ctl): 完善管控命令面`
- Phase 3: `c3ce268 feat(ctl): 构建可恢复 MCP 代理`
- Phase 4: `ab3ad22 feat(ctl): 完成 sidecar 分发`

未 push，未合并 main，未修改 `docs/57-ccpanes-ctl-and-mcp-orphan.md`，未提交 `WORKER-INSTRUCTION.md` 或本报告。

## Phase 完成情况

### Phase 0: 端点发现

- 完成 auto/dev/release/自定义数据目录候选：`cc-panes-ctl/src/discovery.rs:79`。
- 保持 orchestrator-only 解析边界：`cc-panes-ctl/src/discovery.rs:122`。
- 新增 daemon manifest 发现与身份核对：`cc-panes-ctl/src/discovery.rs:174`、`:556`。
- cli-hook 复用无 full feature 的 ctl discovery，既有回归保持通过。

### Phase 1: MCP 客户端与通用工具面

- Streamable HTTP MCP 客户端、session/protocol initialize：`cc-panes-ctl/src/mcp.rs:70`、`:106`。
- 运行时 `tools/list` 与 schema：`cc-panes-ctl/src/mcp.rs:140`、`cc-panes-ctl/src/commands.rs:362`。
- 通用 `tools/call` 与 schema 转型参数：`cc-panes-ctl/src/mcp.rs:185`、`cc-panes-ctl/src/commands.rs:373`。
- `launchId` 进入下游 MCP URL：`cc-panes-ctl/src/mcp.rs:312`。

### Phase 2: 管控命令面

- 双源 status：`cc-panes-ctl/src/commands.rs:23`。
- sessions list/read/submit/write/kill：`cc-panes-ctl/src/commands.rs:58`、`:102`、`:134`、`:160`、`:173`。
- bindings list/close/reconcile：`cc-panes-ctl/src/commands.rs:183`、`:224`、`:282`。
- launch：`cc-panes-ctl/src/commands.rs:332`。
- 离线写逃生阀的 schema/CAS/事务/回读：`cc-panes-ctl/src/offline_db.rs:101`、`:263`。
- `cc-panes-ctl/src/commands.rs` 保持 798 行。

### Phase 3: 可恢复 MCP 代理

- 上游 initialize 终结及状态：`cc-panes-ctl/src/proxy.rs:46`、`:152`。
- 下游独立握手、代次与端点轮换：`cc-panes-ctl/src/proxy.rs:250`。
- `tools/list_changed` 与缓存恢复：`cc-panes-ctl/src/proxy.rs:136`、`:416`。
- reset/超时的“结果不确定”、有副作用调用不重放：`cc-panes-ctl/src/proxy.rs:403`。
- stdio 主循环：`cc-panes-ctl/src/proxy.rs:432`。
- adapter 灰度契约和绝对命令要求：`cc-cli-adapters/src/lib.rs:583`。

### Phase 4: workspace 与 sidecar 分发

- 根 workspace/lockfile 归并：`Cargo.toml:9`；删除独立 `cc-panes-ctl/Cargo.lock`。
- 联合构建、复制清理、placeholder、Tauri resource：`scripts/build-hook.cjs:21`、`scripts/copy-hook.cjs:29`、`:62`、`src-tauri/build.rs:67`、`src-tauri/tauri.conf.json:47`。
- 默认关闭的 `CCPANES_MCP_PROXY`、`CC_PANES_CTL_BINARY` 覆盖、打包资源/当前 exe 绝对路径解析：`cc-panes-core/src/services/ctl_sidecar.rs:9`。
- Tauri 注入真实 resource dir：`src-tauri/src/lib.rs:1558`、`cc-panes-core/src/services/terminal_service.rs:1271`。
- 本地 Claude/Codex 统一 adapter options 注入：`cc-panes-core/src/services/terminal_service.rs:1423`。
- WSL 绝对 `cmd.exe` 探活、参数安全检查、stdio invocation 与 Codex resume 前覆盖：`cc-panes-core/src/services/terminal_service/wsl_mcp_proxy.rs:12`、`:63`、`:89`。
- WSL Claude/Codex 切换点：`cc-panes-core/src/services/terminal_service/wsl_codex.rs:1097`、`:1260`、`:1336`。

## 验证结果

- `cargo clippy --workspace -- -D warnings`：退出码 0；显式输出 `EXIT=0`。
- `cargo fmt --all -- --check`：退出码 0。
- `cargo test -p cc-panes-ctl`：退出码 0；28 passed。
- `cargo test -p cc-panes-cli-hook`：退出码 0；27 passed。
- `cargo test -p cc-cli-adapters`（Phase 3）：退出码 0；102 passed；Linux test cfg 有 3 个既有 dead_code warning，workspace Clippy 无警告。
- `cargo test -p cc-panes-core ctl_sidecar`：退出码 0；5 passed。
- `cargo test -p cc-panes-core wsl_mcp_proxy`：退出码 0；5 passed。
- `cargo test -p cc-cli-adapters mcp_proxy`：退出码 0；3 passed。
- `cargo build -p cc-panes-ctl`：退出码 0。
- `cargo check -p cc-cli-adapters --target x86_64-pc-windows-msvc`：退出码 0。
- `node --check scripts/build-hook.cjs`、`node --check scripts/copy-hook.cjs`：退出码均为 0。
- `cargo metadata --format-version 1 --no-deps`：退出码 0；`cc-panes-ctl` 已是 workspace member/default member。
- WSL 实测 preflight：解析绝对 `cmd.exe` 并执行 `exit /B 0`，退出码 0。
- WSL 实测 stdio：`printf ... | cmd.exe /D /C call ...findstr.exe`，退出码 0，stdout 回显 `ccpanes-stdio-probe`。
- WSL 实测带空格 Windows 路径：`cmd.exe /D /C call "C:\\Program Files\\Git\\cmd\\git.exe" --version`，退出码 0。
- `git diff --check` 与提交前 `git diff --cached --check`：退出码 0。

按指令未运行 `cargo test --workspace`。未运行前端测试/TypeScript 检查，本 Phase 无前端源码改动，worker 最终门禁未要求它们。

## 未做到或未验证

- 未实施 docs/57 §1.2 的 `OrchestratorStatus` lifecycle/attempt/error/retry/UI 可见报警；本 worker 按指令完成的是 ctl Phase 0-4。
- `cargo check -p cc-panes-core --target x86_64-pc-windows-msvc` 退出码 101：WSL 缺 MSVC `lib.exe`，`libsqlite3-sys` build script 在 core 编译前终止；未据此改代码。
- 未在 Windows host 构建并复制 `cc-panes-ctl.exe` 到真实 `debug\\binaries`，也未验证安装包 resources 中的 sidecar；WSL 只构建了 Linux ctl。
- 未启动 Windows Tauri/WebView2/PTY，因此未验证桌面 app 启动、真实 Claude/Codex 新会话/resume、endpoint/token 轮换后的在线恢复。
- 未跑完整 `{local, WSL} x {Claude, Codex} x {new, resume} x {proxy on, off} x {skip_mcp}` 灰度矩阵与 shared MCP 共存人工验收。
- WSL stdin/stdout 与含空格路径已实测；真实长驻 proxy 的取消信号/进程回收未验证，需 Windows host 以实际 CLI 子进程检查。
- interop 禁用未改系统配置做破坏性验证；可读错误文本与失败分支有单测。

## 与 docs/57 的偏离

- WSL 仍采用决议 A，但从字面 `cmd.exe /C <path>` 收紧为经 WSL 实测可工作的 `<绝对 WSL cmd.exe> /D /C call <Windows 绝对 ctl 路径> ...`。`/D` 禁止 AutoRun 污染，`call` 保证含空格 executable 可执行；不使用 `start`，保留直接 stdio/子进程关系。
- 对 `%`、换行、引号及 cmd 元字符等无法安全跨二次解析的路径/参数明确失败，而不是拼接执行。
- 代理开关保持默认关闭；只有 `CCPANES_MCP_PROXY=1` 或已有显式 adapter opt-in 才生效。
- 其余 Phase 0-4 未发现规格偏离。

## 冲突预判

- 高：`cc-panes-core/src/services/terminal_service.rs`、`wsl_codex.rs`、`src-tauri/src/lib.rs`，并行启动链/WSL/资源目录改动可能冲突。
- 中：根 `Cargo.toml`/`Cargo.lock`、`scripts/build-hook.cjs`、`scripts/copy-hook.cjs`、`src-tauri/build.rs`、`tauri.conf.json`，其它 crate/sidecar 分发线可能改同一区域。
- 中：`cc-cli-adapters/src/lib.rs`，其它 adapter options/helper 改动可能冲突。
- 低：新增 `ctl_sidecar.rs`、`wsl_mcp_proxy.rs` 和 `cc-panes-ctl` 独立 crate 文件。

WORKER-DONE
