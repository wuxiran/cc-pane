# 15. WSL / SSH 远程运行

> Claude / Codex 不一定非得在本机 Windows 上跑——CC-Panes 还能把它们开到 **WSL**（Windows 里的 Linux 子系统）或 **SSH 远程机器**上。

## 什么时候用

- 项目依赖 Linux 工具链（某些 Rust / Go / Docker 场景），不想在 Windows 上折腾
- 代码本来就在远程服务器上，直接在那跑

## 怎么选运行环境

启动一个任务时，启动选项里就能选**本机 / WSL / SSH**：

- **本机**：就在当前 Windows 上跑。
- **WSL**：在 WSL 的 Linux 环境里跑。
- **SSH**：在远程服务器上跑。

工作空间也可以设一个**默认运行环境**（右键工作空间 → 运行环境），省得每次选。

## WSL：路径要注意

CC-Panes 大多数操作会帮你处理好路径。但如果你**在对话里手动贴 Windows 路径**给在 WSL 里跑的 AI，要转成 Linux 形式（`/mnt/...`），它才打得开：

| 你的 Windows 路径 | 在 WSL 里写成 |
| --- | --- |
| `C:\Users\foo\plan.md` | `/mnt/c/Users/foo/plan.md` |
| `D:\code\repo\src\foo.rs` | `/mnt/d/code/repo/src/foo.rs`（盘符小写） |
| `\\wsl.localhost\Ubuntu\home\foo` | `/home/foo` |
| 已经是 `/mnt/...` 或 `/home/...` | 原样用 |

> 小技巧：在 WSL 终端里跑 `wslpath -u "D:\code\repo"` 能自动帮你转。

## SSH：先把机器配好

用 SSH 远程跑之前，先在左侧 **SSH 机器**（服务器图标）视图里**加一台机器**：填主机、用户、端口、认证方式（密钥 / 密码），可以“检测连通性”确认能连上。远程机器上也要装好你要用的 CLI。配好后，启动时选这台 SSH 机器即可。

> 这种方式只在远端跑**裸 CLI**：MCP、skills、记忆、resume 都带不过去。想在服务器上用到完整功能，请改用下面的「设备」。

## 设备：用服务器 / 其他电脑上的 CC-Panes

左侧 **设备** 视图把另一台机器上的 CC-Panes 连进来。会话由那台机器自己的 CC-Panes 启动，所以 MCP、skills、记忆都按它的配置注入。

- **SSH 服务器**：
  1. 先在「SSH 机器」里配好这台机器；
  2. 在「设备 → 添加设备 → SSH 服务器」里选中它，勾选“添加后立即部署”；
  3. CC-Panes 会把服务端装到 `~/.cc-panes/bin`，并以 systemd 用户服务启动。服务只监听服务器的 127.0.0.1，经 SSH 隧道访问。
- **其他电脑**：
  1. 在那台电脑的「设置 → Web 访问 → 其他设备」里勾选“允许其他设备连接”，保存后生成配对码；
  2. 在本机的「设备 → 添加设备 → 直连」里填写对方给出的地址和配对码。建议用 Tailscale 地址（100.x）。

设备卡片会显示：
- 在线状态和版本；
- claude / codex 有没有装；
- 对方的工作空间，以及正在运行的会话。

点一个运行中的会话，它就会作为标签打开在本机窗格里。在项目旁点 `+`，可以选一个 CLI 在对方机器上新建会话。

设计细节见 [docs/111-multi-device.md](../111-multi-device.md)。

## 注意

- **WSL**：CC-Panes 登记的项目路径保持原样，只有你手动贴的**文件路径**才需要转成 `/mnt/...`。
- **SSH**：连接不稳 / 延迟大时体验会差；排查方向是网络、密钥权限、远程 CLI 是否装好。

## 下一步

- 回到 [手册首页](README.md) 看完整目录
- 高级玩法总纲 → [用 MCP 让 AI 自己操控 CC-Panes](mcp-orchestration.md)
