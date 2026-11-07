# 111 · 多设备：连接服务器 / 其他电脑上的 CC-Panes

## 背景

旧的 SSH 支持是“本机 CC-Panes 在服务器上开一个 PTY，跑服务器上的 CLI”（`build_ssh_remote_command`）。这样跑起来的只是裸 CLI：

- MCP、技能、hooks/记忆、`--resume`、编排注入全部被跳过；
- 不检查服务器上有没有装 claude。

多设备换了一种做法：**每台设备都跑自己的 CC-Panes，本机作为客户端连过去**。

- 会话由对方机器上的 CC-Panes 在它本地启动，所以注入的东西都按对方的工作空间配置齐全。
- 本机能看到对方的工作空间、运行中的会话，以及 CLI 安装状态。
- 对方的会话可以直接开在本机窗格里。

| 设备类型 | 对方运行什么 | 怎么连 |
|---|---|---|
| SSH 服务器 | headless `cc-panes-web --headless`，只监听 127.0.0.1 | 经已保存的 SSH 机器做本地端口转发 |
| 其他电脑（直连） | 桌面版 CC-Panes 自带的 Web 服务，打开「允许其他设备连接」 | 局域网 / Tailscale 地址 + 配对码 |

## 架构

```
本机 (Tauri)                                       对方设备
 DeviceService ── SSH direct-tcpip 转发 ─────────▶ 127.0.0.1:18765 cc-panes-web --headless
              └─ 或 http://<LAN/Tailscale IP>:port ▶ 桌面 CC-Panes 的 Web 服务（allowDevices）
 RemoteSessionRouter / RoutingTerminalBackend          ├─ 设备令牌（Bearer / WS ?token=）
 TerminalDaemonEventBridge（复用）── /ws/{id} ──▶       ├─ /api/device/info /api/environment
 「设备」侧栏 + 窗格标签                                 └─ /api/sessions*（与 daemon 同构）
```

### 鉴权（cc-panes-web）

- **设备令牌** `ccp_dev_…`：
  - 存在 `<data_dir>/device-tokens.json`，只存 SHA-256；
  - 服务按 mtime 热加载，吊销即时生效；
  - 用 `Authorization: Bearer` 传递，WS 路径也接受 `?token=`。
  - 带了无效令牌直接 401，不回落 cookie。
- **`--headless` / `--require-token`**：回环来源也必须带凭据。原因是 SSH 隧道进来的流量在服务端看来就是 127.0.0.1。
- **设备令牌视同本机主人**，不受远程只读限制，但仍受 IP 白名单约束。非回环来源还需要满足以下任一条件：
  - `allowLan`；
  - `allowDevices`；
  - headless 模式。
- **DNS 重绑定守卫**（`browser_trust`）只对“不带 Origin 的设备请求”放宽：要么带设备令牌，要么访问 `/api/device/pair` / `/api/health`。浏览器请求不受影响。
- **配对码**：
  - 6 位数字，5 分钟有效，最多尝试 5 次，用一次即作废；
  - 只存摘要，和令牌放在同一个文件里。由桌面进程生成，由 Web 进程兑换。
- **免鉴权路由**：`/api/health`，`/api/device/pair`（要求 `allowDevices` 或 headless）。

### 部署（SSH 设备）

`device_deploy`（Tauri）编排，SSH 原语在 `cc-panes-core/src/services/device_deploy.rs`：

1. **探测平台**：`uname`、`$HOME`，以及交互式登录 shell 的 `PATH`（这样 nvm / npm 全局装的 claude 也能找到）、systemd user 是否可用、linger 是否开启、已装版本。
2. **选二进制**：
   1. 环境变量 `CCPANES_DEVICE_SERVER_BINARY`；
   2. 对方与本机同平台时，用随包的 `cc-panes-web`；
   3. 否则下载同版本发布包 `cc-panes-web_<ver>_linux-<arch>.tar.gz`，并校验 `.sha256`。
3. **安装**：SFTP 上传到 `~/.cc-panes/bin/cc-panes-web.new`，再 `mv`（服务运行中也能替换）。
4. **启动**：
   - 有 systemd 时，写 `~/.config/systemd/user/cc-panes-web.service`（`Environment=PATH=<登录 PATH>`），然后 `enable` + `restart`；linger 关闭时给出提醒。
   - 没有 systemd 时，用 `nohup` + pidfile 启动，并提示重启后不会自动拉起。
5. **等端口就绪**：等 `/api/health`。
6. **令牌**：已有令牌且可用就沿用；否则在远端执行 `cc-panes-web token create`，新令牌存进本机 keyring。

服务端发布包用 `--no-default-features` 构建，不带 Secret Service，所以运行时不依赖 libdbus。只依赖 glibc ≥ 2.35 和 OpenSSL 3。

### 远程会话

对端 cc-panes-web 的会话 API 与 cc-panes-daemon 同构：

- HTTP 接口：`/api/sessions`、`/{id}/write|resize|status|snapshot|recovery-snapshot`；
- WS 消息：`output` / `exit` / `killed` / `desync`。

所以远程会话直接复用 `DaemonTerminalBackend` 和桌面端的 `TerminalDaemonEventBridge`，只是地址换成设备地址、令牌换成设备令牌。

- **`DeviceTerminalBackend`**：
  - 每次调用解析设备端点。隧道重建（本地端口变化）或令牌更新后自动换用新的 client；
  - 遇到传输错误时，丢掉隧道重试一次；
  - 缓存最近一次拿到的会话状态。
- **`RemoteSessionRouter`**：记录会话 id → 设备的映射，存到 `remote-sessions.json`，应用重启后已打开的远程标签仍能重连。
- **`RoutingTerminalBackend`**：`TerminalBackendState::backend()` 在有远程会话时返回它。
  - 登记过的会话走设备，其余走本地。
  - 全局状态只附带远程会话的缓存状态，不打网络。
- **前端**：
  - “打开”或“新建”都先在后端登记，再用 `markSessionLive` + `adoptSession` 建一个待重连的标签。
  - 这个标签走的是重连本机会话的同一条恢复路径（`get_terminal_recovery_snapshot` 会启动事件桥）。
- **兜底**：恢复时如果期待复用的是远程会话，后端只在对端把它接回；对端会话已结束就报错，**绝不**在本机用对端路径新建。

## 使用

- **SSH 服务器**：
  1. 先在「SSH 机器」里添加机器；
  2. 在「设备 → 添加设备 → SSH 服务器」里选这台机器，勾选“添加后立即部署”；
  3. 部署完成后，设备卡片会显示 claude / codex 的安装状态、工作空间和运行中的会话；
  4. 点运行中的会话即可打开；在项目上点 `+` 新建会话。
- **其他电脑**：
  1. 在那台电脑的「设置 → Web 访问 → 其他设备」里勾选“允许其他设备连接”，保存后生成配对码；
  2. 在本机的「设备 → 添加设备 → 直连」里填写对方给出的地址和配对码。
- **Docker**：`docker compose up -d`，然后 `docker compose exec cc-panes-web cc-panes-web token create --name <本机名>`，再以“直连”方式添加，填 `http://<host>:8080` 和令牌。

## 限制（本期不做）

- headless 服务端上没有 `ccpanes` 编排 MCP（orchestrator 只在 src-tauri 里），远程会话拿不到 dispatch 和 leader/worker 工具。
- 设备视图靠轮询（10s，仅在视图可见时）。没有全局事件推送。
- 远程终端要求 `http://` 地址：daemon client 是裸 TCP，不支持 TLS。Tailscale 下请用 100.x 的 tailnet IP，不要用 `tailscale serve` 的 https 域名。
- 明文 HTTP 的局域网地址会在添加时给出警告，建议只在 Tailscale 或本机回环上使用。
- 不支持整个 UI 切到另一台设备（设置、MCP、技能、资源库都远程操作）。

## 验证

- **单元测试**：
  - `device_token_service`：令牌和配对码的往返、单次使用、尝试次数上限；
  - `device_auth_tests`：令牌、headless、WS 查询参数、配对、Host 守卫；
  - `remote_terminal`：路由登记表的持久化；
  - 前端：`devicesModel`、`openRemoteSession`。
- **`cargo run -p cc-panes-core --example device_e2e -- <host> <port> <user> <key> <server_binary>`**：对真实 SSH 主机跑完整流程。
  - 覆盖：部署、令牌、隧道上的 HTTP 和 8 路并发、重新部署、远程 shell 写入后读回输出、WS 101 握手、kill 后注销。
  - 已在 Docker sshd 容器（无 systemd，走 nohup）上实测通过。
- **`cargo run -p cc-panes-core --example device_direct_e2e -- <base_url> <token>`**：直连设备的远程 shell 往返。已用本机局域网 IP 实测通过。
