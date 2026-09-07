
---

## macOS 安装说明

由于应用未经 Apple 签名，macOS 可能提示"文件已损坏"或"无法验证开发者"。请使用以下任一方式解决：

**方式一：系统设置（全版本可用）**
先双击打开一次（会被拦截），然后打开"系统设置 → 隐私与安全性"，在底部找到被阻止的应用，点击"仍要打开"。

**方式二：终端命令**
```bash
xattr -cr /Applications/CC-Panes.app
```

> 注意：旧教程里的"右键 → 打开"绕过方式在 macOS 15 Sequoia 已被系统移除，请使用上面两种方式。

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
