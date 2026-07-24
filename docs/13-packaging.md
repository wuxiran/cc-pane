# 阶段 13：打包发布

## 目标

配置跨平台打包、自动更新、发布流程。

## 状态

✅ 大部分完成

## 任务清单

- [x] 配置应用图标
- [x] Dev/Release 并行运行隔离
- [x] 配置 Windows 打包（NSIS installer）
- [x] 配置自动更新（tauri-plugin-updater）
- [x] 配置 GitHub Actions Release 工作流 (`.github/workflows/release.yml`)
- [ ] 配置 macOS 打包（DMG）— CI 有配置但未完全验证
- [ ] 配置 Linux 打包（AppImage / deb）
- [ ] 编写安装文档
- [ ] 版本号管理脚本

## Dev/Release 隔离方案

### 问题

`tauri dev` 和安装后的 release 版共享同一数据目录 `~/.cc-panes/`、同一 app identifier `com.ccpanes.app`，同时运行会导致：

| 冲突 | 严重性 |
|------|--------|
| SQLite 数据库并发写入 | **CRITICAL** |
| 全局快捷键竞争 | HIGH |
| 系统托盘图标无法区分 | MEDIUM |
| App identifier 注册表冲突 | MEDIUM |
| Win32 截图窗口类名冲突 | LOW |

### 方案：`cfg!(debug_assertions)` 编译时隔离

`tauri dev` = debug build，`tauri build` = release build，天然对齐，零额外配置。

| 项目 | Dev (debug) | Release |
|------|-------------|---------|
| 数据目录 | `~/.cc-panes-dev/` | `~/.cc-panes/` |
| App identifier | `com.ccpanes.dev` | `com.ccpanes.app` |
| 窗口标题 | CC-Panes [DEV] | CC-Panes |
| 托盘 tooltip | CC-Panes [DEV] | CC-Panes |
| 截图快捷键 | `Ctrl+Alt+Shift+S` | `Ctrl+Shift+S` |
| 截图窗口类名 | `CCPanesDevScreenshotOverlay` | `CCPanesScreenshotOverlay` |

核心常量：`src-tauri/src/utils/app_paths.rs` 中的 `APP_DIR_NAME`。

Dev 配置覆盖文件：`src-tauri/tauri.dev.conf.json`（覆盖 identifier 和窗口标题）。

### 使用方式

```bash
# 开发模式（与 release 隔离）
npm run tauri:dev

# 构建 release 安装包
npm run tauri build
```

## 构建命令

### Windows

```bash
npm run tauri build
# 产物: src-tauri/target/release/bundle/nsis/CC-Panes_x.x.x_x64-setup.exe
```

### macOS

```bash
# Apple Silicon
npm run tauri build -- --target aarch64-apple-darwin
# 产物: src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/CC-Panes.dmg

# Intel
npm run tauri build -- --target x86_64-apple-darwin
```

### Linux

```bash
npm run tauri build
# 产物:
# src-tauri/target/release/bundle/deb/cc-panes_x.x.x_amd64.deb
# src-tauri/target/release/bundle/appimage/cc-panes_x.x.x_amd64.AppImage
```

## tauri.conf.json 打包配置说明

`bundle` 部分的关键配置：

| 字段 | 说明 |
|------|------|
| `targets` | 打包目标，设为 `"all"` 生成全部格式 |
| `icon` | 各平台图标路径（.ico / .icns / .png） |
| `category` | 应用分类，如 `"DeveloperTool"` |
| `windows.nsis` | NSIS 安装器配置（安装模式、语言等） |
| `macOS.minimumSystemVersion` | 最低 macOS 版本 |
| `linux.deb` / `linux.appimage` | Linux 打包配置 |

自动更新通过 `plugins.updater` 配置，需要生成签名密钥对，并在 `endpoints` 中指向 GitHub Releases 的 `latest.json`。

## Windows 卸载

NSIS 安装器通过 `src-tauri/nsis/installer-hooks.nsh` 处理升级和卸载：

- 安装、升级或卸载前，只结束可执行路径位于当前 `$INSTDIR` 的 `cc-panes.exe`、`binaries/cc-panes-daemon.exe` 和 `binaries/cc-panes-web.exe`。同机的开发版或其他安装目录不受影响。
- 交互卸载完成后会询问是否同时删除应用数据，默认按钮是“否”。选择“是”只删除 `%APPDATA%\com.ccpanes.app`、`%LOCALAPPDATA%\com.ccpanes.app` 和 `%USERPROFILE%\.cc-panes` 三个固定路径。
- `/S` 静默卸载和 updater 的 passive 升级路径不会显示询问，也绝不删除用户数据。

固定路径删除无法发现“设置 → 通用 → 数据目录”配置的自定义 `data_dir`。卸载前应先在“设置 → 关于 → 卸载前清理”撤销 CLI 注入，再自行备份或删除自定义目录。

NSIS 的 `RMDir /r` 没有在此 hook 中提供可靠的 junction/reparse-point 拒绝机制。如果上述任一固定目录被改造成 junction，请在询问中选择“否”，核验真实目标后再手动处理，避免把链接目标当普通应用数据递归删除。

“卸载前清理”只反向移除能够用 CC-Panes 命名空间、hook 二进制名、内置插件内容或受管 MCP URL 签名证明所有权的条目。用户手写的同名配置会保留；不可达项目和解析失败的文件会列入清理报告，而不会强制覆盖。

不选择删除数据时，卸载后可能保留：

| 范围 | 可能残留 |
|------|----------|
| 应用数据 | `%USERPROFILE%\.cc-panes` 或自定义 `data_dir` |
| Tauri / WebView2 | `%APPDATA%\com.ccpanes.app`、`%LOCALAPPDATA%\com.ccpanes.app` |
| CLI 全局注入 | `~/.claude/commands/ccpanes`、Claude/Codex 的 `ccpanes-*` skills、受管 Grok MCP 配置 |
| 项目注入 | `.claude/settings.local.json`、`.codex/hooks.json`、`.opencode/plugins/ccpanes.js` 中由 CC-Panes 写入的条目 |

已经卸载或需要逐项核验时，参见[附录 A：数据存在哪 / 备份与排障](guide/appendix-a-data-and-troubleshooting.md#卸载与手动清理)。

## GitHub Actions Release 工作流概要

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    strategy:
      matrix:
        include:
          - platform: windows-latest
            args: ''
          - platform: macos-latest
            args: '--target aarch64-apple-darwin'
          - platform: macos-latest
            args: '--target x86_64-apple-darwin'
          - platform: ubuntu-22.04
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: dtolnay/rust-action@stable
      - name: Install dependencies (Ubuntu)
        if: matrix.platform == 'ubuntu-22.04'
        run: sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
        with:
          tagName: v__VERSION__
          releaseName: 'CC-Panes v__VERSION__'
          releaseDraft: true
```

## 发布流程

1. 更新版本号（`src-tauri/tauri.conf.json` + `package.json` + `Cargo.toml`）
2. 提交并创建 git tag：`git tag v0.x.x && git push origin --tags`
3. GitHub Actions 自动构建各平台安装包并创建 Draft Release
4. 编辑 Release 说明后发布

## 下一步

打包发布完成后，项目进入持续维护阶段。
