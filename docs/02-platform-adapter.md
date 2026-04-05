# 阶段 2：跨平台兼容

> 状态：📋 待实现

## 目标

确保应用在 macOS 上正常运行。当前主要在 Windows 环境下开发，需要验证和适配 macOS 及 Linux 平台。

> **注意：** 旧版文档中的"平台适配层"概念（调用 Windows Terminal / iTerm2 / tmux 等外部终端）已废弃。CC-Panes 现在使用内置 PTY 终端 (portable-pty + xterm.js)，不需要调用外部终端程序。

## 任务清单

- [ ] macOS 编译和运行测试
- [ ] macOS PTY 兼容性验证 (portable-pty 跨平台支持)
- [ ] macOS 文件路径处理 (~ 展开, 路径分隔符)
- [ ] macOS 快捷键适配 (Cmd 替代 Ctrl)
- [ ] macOS 窗口行为适配 (红绿灯按钮、全屏)
- [ ] macOS 应用签名和公证 (可选)
- [ ] Linux 基础兼容性测试

## 需要关注的跨平台差异点

### 1. PTY 创建方式

portable-pty 在不同平台使用不同的底层实现：

- **Windows**: ConPTY (Windows Pseudo Console API)
- **macOS / Linux**: Unix PTY (openpty / forkpty)

需要验证 PTY 创建、数据读写、进程退出等在各平台的行为一致性。

### 2. 文件路径

- **路径分隔符**: Windows 使用 `\`，macOS/Linux 使用 `/`
- **Home 目录**: Windows 为 `C:\Users\xxx`，macOS 为 `/Users/xxx`，Linux 为 `/home/xxx`
- **`~` 展开**: 确保用户输入的 `~` 路径在各平台正确展开
- **SQLite 数据库路径**: 确保数据库文件存放在各平台的正确位置

### 3. 键盘快捷键

- macOS 用户习惯使用 `Cmd` 键替代 `Ctrl` 键
- 需要在前端适配 `Cmd+C` / `Cmd+V` 等常用快捷键
- Tauri 的快捷键注册需要区分平台

### 4. 窗口装饰

- macOS 的红绿灯按钮 (traffic light buttons) 位于左上角
- 无边框模式下需要特殊处理 macOS 的窗口控制区域
- 全屏行为在 macOS 上与 Windows 不同

### 5. 字体渲染

- xterm.js 在不同平台的字体渲染可能有差异
- macOS 默认使用 `Monaco` 或 `Menlo` 字体
- 需要为各平台配置合适的默认终端字体

## 下一步

进入 [阶段 3：TUI 界面（已归档）](./03-tui-interface.md)
