# CC-Panes iPhone 第一阶段

定位：在 iPhone 上远程查看、操作电脑上的 CC-Panes。电脑负责运行 CLI 和任务，
iPhone 复用 `cc-panes-web` 的登录、会话、工作空间和 WebSocket 接口。

## 当前代码

- Flutter Android/iOS 共享登录、工作空间、会话镜像和终端页面。
- iOS 应用名称为 CC-Panes，已声明局域网用途及本地网络 ATS 例外。
- iOS 会话 Cookie 使用 Keychain，按服务器配置和 CookieJar 模式隔离。
- 断线按 1/2/4/8/16/30 秒退避重试，切到后台停止连接，回到前台重新挂接。
- 旧请求或旧 WebSocket 迟到时会被忽略；退出会话不会自动重启。
- 恢复快照在未显示的终端模型中分块解析，完成后替换画面，不把回放逐行展示。
- 默认不改变共享 PTY 尺寸；只读及断线时不能输入或发送 resize。

## 在 Mac 上验证

本次 Windows 开发环境为 Flutter 3.44.4 / Dart 3.12.2。Mac 建议先使用相同 Flutter
版本以减少环境差异，安装 Xcode、iOS 平台组件和 CocoaPods，并完成 Xcode 首次启动配置。
原项目已接入 Flutter 的 Swift Package Manager 工程，但当前 Keychain 插件仍使用
CocoaPods；让 Flutter 处理插件集成，不要直接套用旧版 Podfile 模板。

在本目录执行：

```bash
bash scripts/check-ios.sh
open ios/Runner.xcworkspace
```

脚本先检查、测试，再生成未签名的 iOS 调试构建。它不注册账号、不上传 App Store。
在 Xcode 中选择 Runner → Signing & Capabilities，选择自己的 Team；连接 iPhone、
启用 Developer Mode 并选择该设备，然后运行。

当前 Bundle ID：`com.ccpanes.ccPanesMobile`。正式登记 App Store Connect 前，应确认
使用个人还是公司发布主体，再确定最终 Bundle ID。

## 注册账号与 TestFlight

代码开发和模拟器测试可以先进行。个人真机调试可用 Xcode Personal Team；
TestFlight / App Store 分发需要 Apple Developer Program 会员和对应签名配置。
个人发布显示本人法定姓名，组织发布显示组织名称；组织通常需要 D-U-N-S。

官方说明：[iOS 开发环境](https://docs.flutter.dev/platform-integration/ios/setup)、
[iOS 发布](https://docs.flutter.dev/deployment/ios)、
[Apple 注册入口](https://developer.apple.com/programs/enroll/)。

## 真机验收与后续工作

- 局域网权限允许/拒绝；电脑服务打开远程访问并正确返回只读权限。
- 同 Wi-Fi、HTTPS 远程连接、Wi-Fi/蜂窝切换；过期登录重新认证。
- 中文输入、粘贴、Esc/Tab/Ctrl、软键盘与横竖屏；阅读历史时的滚动位置。
- 锁屏/后台后恢复，确保没有旧连接覆盖新连接、会话退出后没有重启。
- 电脑和手机同时查看同一终端，确认默认镜像不会改变电脑布局。
- 现有接口采用“读取快照后连接输出流”；快照与实时流的序号对齐仍需后续协议完善，
  当前不能把回归测试通过当作无遗漏、无重复输出的端到端保证。
- App 图标、隐私说明、签名、TestFlight 上传及 iPhone 实机验收尚未完成。

Windows 上的 Flutter 分析和测试不等同于 iOS 编译或真机通过。

2026-09-07：Windows 侧 `flutter analyze --no-pub`、`flutter test --no-pub`（48 项）
均通过，退出码 0；Info.plist 结构、Mac 脚本语法和修改范围的空白检查通过。
Mac 的 Xcode 编译、签名、iPhone 安装和 TestFlight 均未执行。
