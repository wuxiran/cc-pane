# CC-Panes

> 面向 AI Coding 重度用户的多实例分屏工作台，以 Claude Code 为核心，同时支持 Codex、Gemini、Kimi、GLM、OpenCode、Cursor 等 CLI 工作流。

[![Latest Release](https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&sort=semver)](https://github.com/wuxiran/cc-pane/releases/latest)
[![CI](https://github.com/wuxiran/cc-pane/actions/workflows/ci.yml/badge.svg)](https://github.com/wuxiran/cc-pane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-1.83+-000000?logo=rust)](https://www.rust-lang.org/)

[下载最新版](https://github.com/wuxiran/cc-pane/releases/latest) · [English README](README.md) · [反馈问题](https://github.com/wuxiran/cc-pane/issues)

<p align="center">
  <img src="docs/assets/images/current-ui.png" alt="CC-Panes 深色工作区界面" width="920" />
</p>

CC-Panes 是一个桌面端 AI 编程控制台。它把项目、终端、启动配置、Provider、Todo、文件浏览、Git 状态、本地历史、会话恢复放到同一个工作台里，方便你同时推进多个 AI Coding 任务。

它不是单纯的终端壳子，而是给 Claude Code、Codex、Gemini 等 CLI 工作流补上项目组织、并行编排、上下文恢复和桌面工具链。

## 它解决什么

- 多个 AI 会话并排运行，不再在一堆终端窗口里切来切去。
- 工作区、项目、任务、Todo、历史会话统一管理。
- 从应用内恢复历史 Claude/Codex/Gemini 会话，不用手动找命令。
- 启动时选择 Provider、配置档、运行环境、Skill 策略和项目上下文。
- 内置文件浏览、代码编辑、本地历史、Git 工具，减少来回切 IDE。
- 截图、语音输入、通知、托盘、快捷键、小窗模式适合长时间工作流。

## 截图

| 多 Pane 工作区 | 终端主工作区 |
| --- | --- |
| <img src="docs/assets/images/screenshot-new-ui.png" alt="CC-Panes 多 Pane 终端布局" width="440" /> | <img src="docs/assets/images/screenshot-panel.png" alt="CC-Panes 终端面板" width="440" /> |

| Todo 与任务管理 | 浅色工作区 |
| --- | --- |
| <img src="docs/assets/images/screenshot-todolist.png" alt="CC-Panes Todo 和任务面板" width="440" /> | <img src="docs/assets/images/screenshot-main.png" alt="CC-Panes 浅色工作区" width="440" /> |

## 核心能力

**多实例终端**

- 基于 xterm.js 和 portable-pty 的真实 PTY 终端。
- 支持分屏、Tab、多 Pane 布局和终端尺寸同步。
- 可启动 Claude Code、Codex、Gemini、Kimi、GLM、OpenCode、Cursor。
- 记录启动历史，支持按项目恢复历史会话。

**工作区和项目**

- 工作区、项目树、置顶、隐藏、排序、扫描、导入、新建项目。
- 每个项目拥有独立的启动历史、任务、Todo、MCP 配置和元数据。
- 内置文件浏览器，支持搜索、新建、重命名、删除、复制、移动和打开编辑器。
- Monaco 编辑器、Markdown 预览、图片预览。

**启动配置和 Provider**

- Launch Profile 管理 CLI、运行环境、Provider、Skill 和环境变量组合。
- Provider 支持 Anthropic、Bedrock、Vertex、OpenAI 兼容代理、Gemini、Kimi、GLM、OpenCode、Cursor 和本地配置档。
- 启动时可以选择继承 Provider、显式指定 Provider，或不注入 Provider。
- 内置 Claude Code commands、agents、hooks 和 CC-Panes skills，适合编排式任务流。

**Git、本地历史和审查**

- Git 分支状态、fetch、pull、push、stash、clone、worktree 辅助能力。
- 分支感知的本地历史快照、标签和 diff 视图。
- 可对比并恢复本地文件版本。

**桌面工作流**

- 开发版和发布版的数据目录、应用标识、快捷键和窗口标题相互隔离。
- 全局截图快捷键、区域截图、多显示器支持。
- 托盘、通知、语音输入、小窗模式、全屏聚焦、快捷键配置。
- 已发布 Windows、macOS、Linux 安装包。

## 下载

预编译安装包在 [最新版 Release](https://github.com/wuxiran/cc-pane/releases/latest) 页面发布。

- Windows: `*_x64-setup.exe` 或 `*_arm64-setup.exe`
- macOS: `*_aarch64.dmg` 或 `*_x64.dmg`
- Linux: `*_amd64.deb` 或 `*_amd64.AppImage`

## 从源码运行

### 环境要求

- Node.js 22+
- Rust 1.83+
- 平台对应的 [Tauri 2 环境依赖](https://tauri.app/start/prerequisites/)
- 你希望由 CC-Panes 启动的 Claude Code、Codex、Gemini 或其他 CLI

### 安装并启动

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

开发版使用 `src-tauri/tauri.dev.conf.json`，数据目录为 `~/.cc-panes-dev/`。

## 构建

只构建前端：

```bash
npm run build
```

构建桌面发布包：

```bash
cargo build -p cc-panes-cli-hook --release
node scripts/copy-hook.cjs
npm run tauri build
```

## 检查命令

前端：

```bash
npx tsc --noEmit
npm run test:run
```

Rust：

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

## WSL 原生开发

如果在 WSL 中开发 CC-Panes，可以把终端强制到 WSL 原生模式：

```bash
CCPANES_TERMINAL_BACKEND=wsl npm run tauri:dev
```

这会让内置终端直接运行 WSL 的默认 shell，适合在 Linux 工具链里开发和调试。

## 架构

CC-Panes 使用分层桌面架构：

```text
React Component
  -> Zustand Store
  -> Frontend Service
  -> Tauri IPC Command
  -> Rust Service
  -> Repository
  -> SQLite / File System / PTY
```

| 层级 | 技术 | 作用 |
| --- | --- | --- |
| 桌面框架 | Tauri 2 | Rust 后端 + 系统 WebView |
| 前端 | React 19、TypeScript 5.6、Vite 6 | 应用界面 |
| 状态管理 | Zustand 5、Immer | 可预测的状态更新 |
| UI | shadcn/ui、Radix UI、Tailwind CSS 4 | 组件和样式 |
| 终端 | xterm.js、portable-pty | 终端渲染和 PTY 管理 |
| 存储 | SQLite、rusqlite | 本地持久化 |
| 测试 | Vitest、jsdom、Rust test | 前后端验证 |

## 项目结构

```text
cc-pane/
├── web/                  # React 前端
│   ├── components/       # UI、Pane、侧边栏、设置
│   ├── stores/           # Zustand 状态
│   ├── services/         # Tauri invoke 封装
│   ├── hooks/            # React Hooks
│   ├── types/            # TypeScript 类型
│   └── i18n/             # 国际化
├── src-tauri/            # Tauri 入口、命令、服务、仓储
├── cc-panes-core/        # 框架无关核心逻辑
├── cc-panes-api/         # HTTP/WebSocket API 适配
├── cc-panes-web/         # Web 终端服务
├── cc-cli-adapters/      # Claude/Codex/Gemini 等 CLI 适配层
├── cc-memory/            # 本地 Memory 系统
├── cc-memory-mcp/        # Memory MCP Server
├── cc-notify/            # 通知模块
├── docs/                 # 文档和截图
└── scripts/              # 构建和工具脚本
```

前端使用 `@/` 路径别名，对应 `web/` 目录。

## 开发版和发布版隔离

| | 开发版 | 发布版 |
| --- | --- | --- |
| 命令 | `npm run tauri:dev` | `npm run tauri build` |
| 数据目录 | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| 应用标识 | `com.ccpanes.dev` | `com.ccpanes.app` |
| 窗口标题 | `CC-Panes [DEV]` | `CC-Panes` |
| 截图快捷键 | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |

涉及 Windows 桌面行为时，需要在 Windows 主机验证。WSL 或 Linux 环境可以做代码和预检，但不能证明 WebView2、托盘、全局快捷键、截图、更新器、安装器或 Windows PTY 行为。

## 反馈

- GitHub Issues: <https://github.com/wuxiran/cc-pane/issues>
- GitHub Discussions: <https://github.com/wuxiran/cc-pane/discussions>

微信群：

<p>
  <img src="docs/assets/images/wechat-group-nightcat-dev.png" alt="NightCat Dev 微信群" width="220" />
  <img src="docs/assets/images/wechat-group-cc-pane.png" alt="CC-Panes 微信群" width="220" />
</p>

## 参与贡献

欢迎提交 Issue 和 PR。较大的功能改动建议先开 Issue 对齐范围和设计。

提交信息使用 Conventional Commits：

```text
feat: add launch profile import
fix: repair Windows PTY resize handling
docs: update README screenshots
```

## License

本项目使用 [GPL-3.0](LICENSE) 协议。

## 致谢

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Tauri](https://tauri.app/)
- [xterm.js](https://xtermjs.org/)
- [portable-pty](https://github.com/wez/wezterm/tree/main/pty)
- [Allotment](https://github.com/johnwalley/allotment)
- [shadcn/ui](https://ui.shadcn.com/)
