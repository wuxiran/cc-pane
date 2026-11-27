# 116 — worktree setup 脚本 与 远程端口预览

## A. worktree 创建后的 setup（`.ccpanes/worktree.json`）

参考 t3code `t3.json` 的 `runOnWorktreeCreate`。按 docs/98 三层职责：配置描述仓库本身，放仓库层可提交；
「始终允许」是这台机器上这个用户的决定，放数据目录，永不进仓库。

```json
// <repo>/.ccpanes/worktree.json
{
  "setup": ["npm ci", "npm run build:types"],
  "copyFiles": [".env", ".env.local", "certs"],
  "sparseCheckout": ["web", "src-tauri"]
}
```

| 字段 | 语义 | 需要批准 |
|---|---|---|
| `setup` | 单行命令数组，拼成一行（Unix `&&`，Windows `;`）在新终端标签执行，cwd 显式为新 worktree 根 | **是** |
| `copyFiles` | 从主树拷到新 worktree 的相对路径（文件或目录）；源不存在静默跳过，目标已存在不覆盖，符号链接与越界路径拒绝 | 否 |
| `sparseCheckout` | `git sparse-checkout set --cone <dirs>` | 否 |

- 读取顺序：新 worktree 里已提交的版本 → 主树（还没提交时方便调试）。
- 实现：`cc_panes_core::services::worktree_setup`（解析/校验/hash/批准/拷贝），Tauri `prepare_worktree_setup`、`approve_worktree_setup`。
- 批准记录：`~/.cc-panes/worktree-setup-approvals.json`，键 = 主树 `project_identity_key`，值 = 配置规范化后的 SHA-256。每个项目只留最新一份，配置一改就要重新批准。

### 两条入口

- **UI**（worktree 管理、启动器的 worktree 隔离）：建好后 `requestWorktreeSetup` → 已批准直接开终端执行；否则弹 `WorktreeSetupDialog`（不执行 / 仅本次执行 / 始终允许）。不阻塞会话启动。Web 壳不做 setup。
- **派发**（plantocodex 的 worktree 隔离模式经 ctl 调 `create_worktree`，仅 `/mcp-full`）：有批准记录就在后台开终端标签执行，否则跳过并在返回值 `setup.status=skipped` + `setup.note` 说明。绝不等待批准，也不等 setup 结束。

## B. 远程 dev server 端口的本机预览

参考 t3code `apps/server/src/preview/PreviewTunnel.ts`。只做 SSH：WSL 的 localhost 本来就通。

- **识别**：SSH 终端注册 `LocalhostPreviewLinkProvider`（`web/lib/localhostPreviewLink.ts`），认 `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]` + 端口（可带 `http(s)://` 与路径）；`foo.localhost`、`user@localhost`、非法端口不算。SSH 会话不再注册本地路径链接（远端路径本机打不开，原来就不注册）。OSC 8 超链接指向回环地址时同样走预览。
- **打开**：点链接 → `open_port_preview(sessionId, ssh, remoteHost, remotePort)` → `PortPreviewService`（core）经 `SshConnectionService::connect_info` 建连（凭据/代理/跳板同一套），复用 `SshPortForward::start_with_local_port` 起本地转发 → 内置浏览器打开 `http(s)://127.0.0.1:<本地端口><路径>`。
- **端口分配**：`ssh_port_forward::bind_loopback` 先试与远端相同的端口（OAuth 回调、写死的地址更可能直接可用），探测到本机已有人应答或绑定失败则让系统挑空闲端口。探测是必须的：std 在 Unix 上开了 `SO_REUSEADDR`，macOS 允许绑到「别人以通配地址监听」的端口，不探测会遮住本机同端口的 dev server。
- **生命周期**：同会话 + 同远端地址复用一条；最多 32 条；SSH 断线的在下次列出/打开时清掉；会话 `terminal-exit` / `session-killed` 时自动回收（`lib.rs` 监听 → `release_port_previews_for_session`）；变化时广播 `port-preview-changed`。
- **列出/关闭**：侧栏 SSH 机器视图底部「端口预览」，有隧道才显示。
- 远端主机只允许回环地址：这是预览远端本机的 dev server，不是任意跳板。

### 待真机验证

- 真 SSH 机器（密钥 / agent / 已存密码 / 代理 / 跳板各一）上点 Vite、Next 的地址行能打开，HMR WebSocket 正常。
- Vite 在 Node ≥17 只监听 `::1` 时，`localhost` 交给远端 sshd 解析能连上。
- 关闭终端标签后隧道消失；网络断开后列表自动清掉。
