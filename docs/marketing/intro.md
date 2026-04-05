# CC-Panes：给 Claude Code 重度用户的多实例分屏管理器

用 Claude Code 做开发的人应该都遇到过这个问题：项目一多，终端窗口满天飞，切来切去效率很低。想同时盯两个项目的 Claude 对话？基本靠手动排窗口。

CC-Panes 就是为了解决这个问题做的——一个专门管理多个 Claude Code 实例的桌面应用，支持分屏、项目管理、终端集成，开箱即用。

## 核心功能

### 多实例分屏

最核心的功能。可以在一个窗口里同时运行多个 Claude Code 实例，自由拖拽分屏布局，不用再手动排列终端窗口。

### 工作空间 / 项目管理

三层模型：Workspace → Project → Task。一个工作空间可以包含多个项目（Git 仓库），每个项目下可以开多个任务标签页。项目支持别名、Provider 绑定、目录扫描批量导入。

### 内置终端

基于 xterm.js + portable-pty 的完整终端，不是玩具。多标签页、分屏、主题跟随，直接在应用内操作，不需要额外开终端。

### Git 集成

内置 Git 操作面板：分支管理、状态查看、pull / push / fetch / stash，以及 Worktree 管理。日常 Git 操作不用切出去。

### Local History

类似 VS Code 的本地文件历史功能。自动记录文件变更，支持 Diff 查看、版本标签、分支感知。Claude 改坏了代码？随时回滚。

### Provider 管理

支持配置多个 API Provider，不同项目可以绑定不同的 Key。适合同时用多个 API 账号或者区分个人 / 工作项目的场景。

### 会话管理

Claude 会话的查看、清理、日志记录。工作空间级别的会话日志，方便回顾。还有一个自我对话助手（Self-Chat），用于快速测试 prompt。

### 其他

- 系统托盘常驻
- 无边框模式 / 迷你模式
- 亮色 / 暗色主题切换
- Hooks 工作流系统
- 启动历史记录

## 技术栈

| 层次 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 (Rust + WebView) |
| 前端 | React 19 + TypeScript |
| 状态管理 | Zustand 5 + Immer |
| UI | shadcn/ui + Radix UI + Tailwind CSS 4 |
| 终端 | xterm.js + portable-pty |
| 分屏 | Allotment |
| 存储 | SQLite (rusqlite) |
| 构建 | Vite 6 |

## 从源码构建

### 前置条件

- Node.js 22+
- Rust 1.83+
- 系统依赖参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)

### 构建步骤

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri dev    # 开发模式
npm run tauri build  # 构建安装包
```

## 项目地址

GitHub: https://github.com/wuxiran/cc-pane

当前版本：v0.9.6

## License

GPL-3.0

---

项目还在积极开发中，功能和 UI 都在持续迭代。欢迎试用、提 Issue、提 PR，也欢迎 Star 支持一下。
