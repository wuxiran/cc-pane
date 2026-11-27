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
