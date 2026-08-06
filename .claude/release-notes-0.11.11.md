完整历史见 [CHANGELOG](https://github.com/wuxiran/cc-pane/blob/main/CHANGELOG.md)。

## 修复（Fixed）

- **`launch_task` 派发的会话在应用重启后永远无法自动接管。** 会话恢复要求创建时落一张「出生凭证」（daemon 世代号 + 出生随机数），但只有手动开终端和 REST 两条路径会写——`launch_task` 与 runner 走的 orchestrator 路径从来不写。结果是所有派发出去的 worker（实测机器上 47 个缺凭证会话里 41 个是 WSL Codex）重启后全被身份校验以「身份不一致」永久拦截，而手动开的终端却能正常接回。现在三条创建路径统一走同一个 fail-closed 落库入口；应用启动时还会对 daemon 里还活着的存量老会话**自动回填凭证**，此前被卡住的会话也能恢复自动接管。

## 变更（Changed）

- **终端「恢复日志」从原始 JSON 变成说人话的文字。** 恢复事件保留结构化存储，渲染为本地时间 + 按严重度着色 + 中英双语可读文案（「本轮恢复完成：接上 15，跳过 0，拦截 1」「会话仍被上一个应用实例占用——写租约 30 秒后自动过期，会自动重试」）。右上角开关可展开原始事件负载用于排障；未知事件自动回退原样显示，不会有信息被藏起来。
- **设置 → Provider 两页全面改版**（对齐前端风格宪法 docs/46）。三层堆叠的导航压成一行（分段子页切换 + 统一尺寸的 CLI 标签 + 页面动作）；运行配置页改单列：概要卡换成无边框摘要条、YOLO 压缩为卡底开关行（删掉了原本大半空白的独立权限卡）、勾选行改中性样式不再满屏蓝底、Skill/MCP 长列表改「折叠组头 + 已启用摘要 chips + 展开内滚动」并新增跨分组搜索；共享 MCP 管理移入右侧抽屉；凭证页收成居中单列。底层：新增 card/segmented/checkbox/checkbox-row/collapsible-group 五个 UI 原语与 Radix select 封装，CLI 品牌色进主题 token，2139 行的巨石组件拆成每个 ≤500 行的文件。

---

## macOS 安装说明

由于应用未经 Apple 签名，macOS 可能提示"文件已损坏"或"无法验证开发者"。请使用以下任一方式解决：

**方式一：终端命令（推荐）**
```bash
xattr -cr /Applications/CC-Panes.app
```

**方式二：右键打开**
在 Finder 中按住 Control 键点击（或右键点击）应用图标，选择"打开"，在弹出的对话框中点击"打开"。

**方式三：系统设置**
打开"系统设置 → 隐私与安全性"，在底部找到被阻止的应用，点击"仍要打开"。

## Linux 安装说明

**Deb 包（Ubuntu/Debian）：**
```bash
sudo dpkg -i cc-panes_*.deb
sudo apt-get install -f  # 安装缺少的依赖
```

**AppImage：**
```bash
chmod +x cc-panes_*.AppImage
./cc-panes_*.AppImage
```
