# CC-Panes OpenHarmony

CC-Panes 的 OpenHarmony（ArkTS/ArkUI）客户端——远程连接桌面端 `cc-panes-web` 服务器，查看和操作运行中的 Claude Code 终端会话。设计参照 [cc-panes-mobile](../cc-pane/cc-panes-mobile)（Flutter 安卓/iPhone 版），交互与文案 1:1 对齐。

## 架构

纯客户端，后端零改动复用（REST + WebSocket 契约与桌面 Web 版完全一致）：

```
entry/src/main/ets/
├── common/     Config（轮询/超时/阈值常量）、Result（错误映射）、Format、Theme（明暗双色板）、Nav
├── model/      全部数据模型 + fromJson；LayoutSnapshot（布局树解析/collectSessionCards）、
│               MirrorState（buildMirrorState 合成，语义有单测锁定 entry/src/test/）
├── services/   ApiClient（HTTP+Cookie，cookie 存 Asset Store）、各域 API、
│               TerminalSocket（/ws/{id} 终端流，Cookie 握手）
├── stores/     状态管理 V2 单例：Auth（静默重登/401 重连）、Mirror（唯一会话数据源，5s 轮询）、
│               Workspaces、LaunchHistory；TerminalController（每会话：phase 状态机、
│               输出 8ms 合批、Ctrl 粘滞、opt-in resize 300ms 去抖）
├── components/ 首页组件（工作区卡/镜像会话卡/启动弹层/工作区菜单）+ 终端组件
│               （TerminalWebView=ArkWeb 桥、KeyBar=快捷键条）
└── pages/      Index（按登录态分流+Navigation 路由）、ConnectPage、MirrorHomePage（双 Tab）、
                TerminalPage（NavDestination）

resources/rawfile/terminal/   xterm.js 6 + fit 插件 + MapleMonoNFCN 等宽字体（离线内置）
```

终端渲染方案：ArkUI **Web 组件** 内跑 xterm.js；VT 字节流 base64 过桥（ArkTS `runJavaScript` 下行 8ms 合批，`javaScriptProxy` 上行输入/几何），流式 UTF-8 解码防 CJK 截断。

## 构建

环境：DevEco Studio 5.x（或命令行 hvigor 5.0.5）、OpenHarmony SDK。命令行：

```bash
hvigorw clean && hvigorw assembleHap --mode module -p module=entry@default -p product=default --no-daemon
```

- 产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`
- **签名**：`build-profile.json5` 的 `signingConfigs` 为空，需在 DevEco Studio 配置签名后出正式包
- 注：本机 DevEco 5 的 hvigor 仅支持 modelVersion 5.0.5，工程已从 6.0.1 降级（更高版本 DevEco 打开可无损升回）

## 连接桌面端

1. 桌面端 CC-Panes 设置 → Web 访问：启用「账号密码登录」+ 设置密码 + 「允许局域网访问」；
   若开了「远程只读模式」，还需开「允许已登录的远程会话写入」才能在手机上操作终端。
2. 放行 Windows 防火墙 18080 入站。
3. 设备连同一局域网，App 中填 `http://<Windows IP>:18080` + 账号密码。
4. Tailscale 路径：桌面端 `tailscale serve --bg --https=443 http://127.0.0.1:18080`，App 填 `https://<host>.ts.net`。

## 功能

- 双 Tab 首页：工作区浏览（指标条/工作区卡/项目行 + 电脑在跑/手机打开徽标）+ 终端镜像（按桌面布局快照分组，5s 轮询，陈旧提示）
- 终端：实时输出、软键盘输入、快捷键条（Ctrl 粘滞/Esc/Tab/^C/方向键/Enter/slash/tilde）、滚动回溯 5000 行、适配尺寸（opt-in，避免影响桌面端渲染）
- 启动会话：Claude / Codex / 纯终端，或从最近启动历史 resume
- 只读模式：输入与写操作客户端拦截 + 服务端 403 兜底，专属文案
- UI 自适配：手机竖屏底部 Tab；≥600vp 宽屏 Tab 栏移顶部、卡片双列
- 明暗主题跟随系统
- 相对 Flutter 版的修复：单一会话数据源（不再有双 controller 分裂）、工作区菜单补「恢复上次布局」入口、空状态文案指向真实入口

## 已知限制（待真机联调）

- ArkWeb 桥的 runJavaScript 实际性能、软键盘避让、字体加载 refit 需真机验证
- set-cookie 响应头大小写/数组形态在不同固件上的差异建议回归一次登录流
- 本地单测（LayoutSnapshot 18 用例）需 DevEco IDE 运行，CLI 无 test 任务
