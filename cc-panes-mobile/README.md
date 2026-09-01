# CC-Panes Mobile

CC-Panes 的跨平台移动客户端——远程连接桌面端 `cc-panes-web` 服务器，查看和操作运行中的 Claude Code 终端会话。

## 平台结构

同一个移动客户端目录下按平台并列维护：

```
cc-panes-mobile/
├── android/       Flutter Android 工程
├── ios/           Flutter iOS 工程
├── lib/           Flutter 共享客户端（Android/iOS）
└── ohos/          OpenHarmony ArkTS/ArkUI 客户端（独立 hvigor 工程）
```

Android/iOS 共用 Flutter 实现；OpenHarmony 使用原生 ArkTS/ArkUI 实现，但复用同一套桌面端 REST + WebSocket 契约和交互设计。OpenHarmony 工程不是 Flutter 的 Gradle 子模块，需在 DevEco Studio 中单独打开 `ohos/`。

## 架构

移动端是纯客户端，复用桌面端 `cc-panes-web`（axum）暴露的 REST + WebSocket 契约：

- REST：`/api/auth/*`（Cookie 会话登录）、`/api/sessions`（会话 CRUD、write/submit/resize/snapshot）
- WS：`/ws/{sessionId}` 文本 JSON 帧（`output`/`exit` 下行，`input`/`resize` 上行）
- 鉴权：`ccp_web_session` HttpOnly Cookie，由客户端持久化，WS 握手复用

```
lib/
├── core/     Result<T,ApiFailure>（对齐后端 AppResult 风格）、常量
├── api/      dio + PersistCookieJar 客户端、auth/sessions API 封装
├── models/   ServerProfile / AuthStatus / SessionInfo（手写 fromJson）
├── state/    riverpod：server_store（secure storage 持久化）、auth_controller（静默重登）、sessions_controller（5s 轮询）
└── ui/       connect / session_list 屏幕（Phase 2 加 terminal）
```

### OpenHarmony 工程

`ohos/` 内是完整的 ArkTS 工程：

- `entry/src/main/ets/`：连接页、工作区栅格首页、终端页、模型、服务和状态控制器
- `entry/src/main/resources/rawfile/terminal/`：xterm.js 终端资源和 MapleMono CJK 等宽字体
- 终端使用 ArkUI Web 组件承载 xterm.js，HTTP/WS 使用 OpenHarmony NetworkKit
- UI 按 xs/sm/md/lg/xl 五档断点自适应手机、平板和宽屏窗口

在 DevEco Studio 中打开 `cc-panes-mobile/ohos/`，或者在该目录执行：

```bash
hvigorw clean
hvigorw assembleHap --mode module -p module=entry@default -p product=default --no-daemon
```

正式发布前请在 DevEco Studio 为 `ohos/` 配置签名；仓库只保留未签名 HAP 的构建流程。

## 开发

前置：Flutter SDK（≥3.5）、Android SDK + adb、真机或模拟器。

```bash
flutter pub get
flutter analyze
flutter test
flutter run              # 连接的设备/模拟器
```

## 连接桌面端
   若开了「远程只读模式」，还需开子开关「允许已登录的远程会话写入」才能在手机上操作终端。
2. 放行 Windows 防火墙 18080 入站。
3. 手机连同一局域网，App 中填 `http://<Windows IP>:18080` + 账号密码。
4. Tailscale 路径：桌面端 `tailscale serve --bg --https=443 http://127.0.0.1:18080`，App 填 `https://<host>.ts.net`。

调试捷径（仅 UI 迭代，来源判 Local 会掩盖只读问题）：
- 模拟器：`http://10.0.2.2:18080`
- 真机 USB：`adb reverse tcp:18080 tcp:18080` 后连 `http://127.0.0.1:18080`

## 分期

- [x] Phase 1：登录 + 会话列表（新建/关闭/状态轮询）
- [ ] Phase 2：xterm 终端渲染 + WS 输入 + 快捷键条
- [ ] Phase 3：断线重连 / 401 静默重登打磨 / 多服务器 UI / 设置页
- [ ] Phase 4：iOS 适配 + TestFlight
