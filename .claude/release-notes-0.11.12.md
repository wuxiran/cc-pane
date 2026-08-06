完整历史见 [CHANGELOG](https://github.com/wuxiran/cc-pane/blob/main/CHANGELOG.md)。

## 新增（Added）

- **工作空间树新增第二种显示模式：运行中的终端。** 侧边栏 WORKSPACES 标题行的切换按钮可在「项目列表」与「运行中的终端」间切换。终端行以**你让那个会话干的第一件事**命名（转录索引追上前暂显标签标题，最多一分钟），项目/CLI 上下文降为次行小字；右侧用状态点+状态词展示会话状态（等输入=琥珀、出错=红、干活=蓝色脉动），分屏标签聚合显示最严重状态和 ×N 计数。点击任意一行跨布局、跨视图直接聚焦该终端。行序稳定不按状态重排——你正要点的行不会突然跳走。所选模式重启后保持。

## 修复（Fixed）

- **窗口控件恢复正常，设置面板不再被浏览器窗格遮挡。** 最小化/最大化/关闭改走原生主窗口；设置对话框不再被内嵌浏览器 WebView 盖住；浏览器协议错误显示本地化文案而非原始报错。（PR #54，感谢 @Curl-007）

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
