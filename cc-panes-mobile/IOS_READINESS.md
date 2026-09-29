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

模拟器验收（无需签名）：`open -a Simulator`，分别启动一台 iPhone 和一台 iPad
（建议 iPad Air 11-inch），`flutter devices` 查设备 ID 后 `flutter run -d <ID>`。
模拟器与电脑同处一机，服务器地址可填 `http://127.0.0.1:18080`；真机需填电脑的局域网 IP。

Mac 上常见卡点：

- `ios/Podfile`、`Podfile.lock` 与 xcconfig/pbxproj 中的 Pods 引用已由 Mac 构建生成并提交，
  这是 Keychain 插件（flutter_secure_storage 9.x，仅 CocoaPods）所需。
  升级到 11.x 可改走 Swift Package Manager、去掉 CocoaPods，但 Android 端存储
  实现随之变化，需单独评估旧凭证迁移，不在本次范围。
- `ios/Flutter/Generated.xcconfig` 已被 gitignore；若从 Windows 拷贝目录而非 git 拉取，
  里面是 Windows 路径，先执行 `flutter clean && flutter pub get` 重新生成。
- `pod install` 要访问 `cdn.cocoapods.org`，直连会被断开（SSL_ERROR_SYSCALL）。Mac 本机代理
  不可用时，可从 Windows 反向借代理：`ssh -R 18809:127.0.0.1:10809 mac`，并在该会话中设置
  `https_proxy=http://127.0.0.1:18809`；pub 与 Flutter 引擎可走国内镜像
  （`PUB_HOSTED_URL=https://pub.flutter-io.cn`、`FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn`）。
- brew 安装的 Flutter 带 macOS 隔离标记，会报 `library load disallowed by system policy`，
  执行 `xattr -dr com.apple.quarantine /opt/homebrew/share/flutter` 后恢复。
- 真机首次连接会弹「本地网络」授权；授权框出现期间的第一次请求可能失败，
  允许后点重连即可。拒绝后需到 设置 → 隐私与安全性 → 本地网络 重新打开。

## iPad 适配（第一阶段）

- 工程已声明 iPhone + iPad（`TARGETED_DEVICE_FAMILY = 1,2`），iPad 支持四个方向且未设
  `UIRequiresFullScreen`，可进入 Split View / Slide Over / 台前调度。
- 布局按**窗口宽度**而非设备类型切换：宽度 ≥ 600 时首页导航由底部栏改为左侧导航栏；
  工作区与终端列表内容限宽 840 居中，连接页表单限宽 480。分屏窄窗口自动退回手机布局。
- 终端页在平板上字号 14（手机 12），按最短边判定，旋转不改字号。
- 底部 sheet 沿用 Material 3 默认的 640 最大宽度，平板上不会横跨整屏。
- 仍不主动 resize 共享 PTY；iPad 上「适配尺寸」会把电脑端同一会话改为 iPad 的列数。

iPad 验收：横竖屏切换、Split View 1/3 与 1/2 宽度、台前调度改变窗口大小、
外接键盘（妙控键盘）下 Esc/Tab/方向键/Ctrl+C 直接生效、快捷键条仍可用。

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

2026-09-28：加入 iPad 基础适配（见上节）。Windows 侧 `flutter analyze --no-pub` 无问题、
`flutter test --no-pub`（53 项，含 5 项自适应布局用例）通过，退出码均为 0。
核对了 Info.plist 与 Flutter 3.44.4 iOS 模板，差异仅为应用名称和两项局域网声明。
iOS / iPadOS 的编译、模拟器与真机运行仍待在 Mac 上执行 `scripts/check-ios.sh` 验证。

2026-09-29：Mac（macOS 26.7 / Xcode 27.0 / Flutter 3.47.1 / CocoaPods 1.16.2）上
`scripts/check-ios.sh` 全部通过，退出码 0：analyze 无问题、53 项测试通过、真机未签名构建与
模拟器构建成功。模拟器 iPhone 17（iOS 27.0）与 iPad Air 11-inch M4（iOS 27.0）均可启动到
连接页，iPad 上表单按 480 宽居中。Flutter 3.47 迁移把最低系统版本提到 iOS 15.0。
尚未执行：登录后的页面（需要桌面端密码）、真机签名安装、TestFlight。
