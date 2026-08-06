本版本以社区贡献为主。感谢 @zhengjunkj、@Curl-007 和 @yanjiuding。

完整历史见 [CHANGELOG](https://github.com/wuxiran/cc-pane/blob/main/CHANGELOG.md)。

## 破坏性变更（Breaking）

- **Codex 不再接受 `config_profile` 类型的 Provider。** Codex 的托管配置是以 OpenAI 兼容 Provider 块的形式写入的，`config_profile` 绑定无法用这种方式表达——过去它会被接受然后静默忽略。现在会在启动时直接拒绝，报 `PROVIDER_INCOMPATIBLE` 并指明是哪个 Provider。如果升级后某个 Codex 启动不了了，去 设置 → Providers 把它改绑到一个 OpenAI 兼容的 Provider。`config_profile` 对 Claude 仍然有效。
- **与所属 CLI 类型不匹配的「per-CLI 默认 Provider」会在首次启动时被丢弃。** 这类绑定本来就不可能启动成功；受影响的 CLI 会回退到原生模式。这个过程没有任何提示——如果某个你指定过 Provider 的 CLI 表现得像全新安装，先去 设置 → Providers 查一下。

## 新增（Added）

- **Provider 现在有显式的托管模式（managed mode）。** 以前想让 CLI 连非默认端点，唯一办法是改那个 CLI 自己的配置文件，这意味着 CC-Panes 和 CLI 可能对「当前用的是哪个 Provider」意见不一致——而连错的 Provider 看起来和连对的一模一样。托管模式下，CC-Panes 改为给 CLI 写一份私有的、每会话独立的配置；无法兑现的 Provider 会让启动直接失败，而不是静默回退到 CLI 自己的设置。你自己的 `~/.config/opencode/config.json`、`~/.codex/`、`~/.claude.json` 只读、永不写入。原生模式（CLI 用自己的配置，和以前一样）按启动配置仍然可选。
- **按 Provider 选择模型。** 启动配置可以钉死一个具体模型，而不是只能用 Provider 的默认值。
- **状态栏显示上下文用量。** Claude 和 Codex 会话会显示上下文窗口已消耗的比例，压缩（compaction）不再是个突然袭击。只在有受支持的会话活跃时才轮询，窗口隐藏时停止。
- **托管 Provider 支持 WSL 会话。** 配置写在 Linux 侧、路径做了相应转换，而不是让 CLI 去读一个它读不到的 Windows 路径。
- **README 补充了 Web 访问和后台设置的文档**，两者都配了录屏。

## 修复（Fixed）

- **OpenCode 可能在启动时永久挂死。** 一次永不完成的托管配置写入会让启动既没有超时也没有报错——窗格就一直空着。现在配置写入有截止时间，超过总时限的启动会被报告为启动超时、清理干净，并与「会话真的退出了」区分开。在慢盘或网络盘上这个时限可能偏紧；如果撞上了，错误信息会指明是哪个阶段超时。
- **从状态栏、首页顶栏或 设置 → 关于 安装更新时，不会警告有会话在跑。** 安装更新会停掉终端 daemon 并重启应用，这会打断每一个正在运行的 agent。此前只有更新卡片会要求确认，另外三个入口直接就装。现在四个入口在有会话运行时都会警告。
- **Provider 配置文件改为原子写入**，被打断的写入不再可能让 CLI 指向一份被截断的配置。Unix 上以仅属主可读的权限创建。
- **布局右键菜单可能出现在布局选择器后面。**
- **ccchan 窗口和 Web 访问设置页无论选什么语言都只显示英文。**
- **原生控件跟随主题**（日期选择器、滚动条等），不再永远渲染成亮色。
- **Linux 上向终端粘贴不再强制重建 IME 上下文。** 这个重建当初是为 issue #41 加的（WebKitGTK 上粘贴后输入法状态残留），作者在 Linux 上实测后移除；guard 本身未动，仍然覆盖显式清理的场景。注意：现在没有测试专门覆盖粘贴路径——如果 #41 复发，从这里查起。
- **Vite dev server 不再监听 Rust 构建输出目录**——那些目录可能膨胀到几十万个文件，把 dev server 拖到停摆。

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
