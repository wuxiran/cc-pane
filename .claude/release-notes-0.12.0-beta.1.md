> ⚠️ **Beta 预发布**：不进稳定版自动更新通道（稳定版仍是 v0.11.13），仅手动下载试用。发现问题请提 issue。

生命周期大版本：docs/78 五批 Tab 生命周期重构全量落地 + M3b checkpoint+delta 恢复归一。100+ 提交、三轮外部评审、全部门禁绿（前端 4044 用例 + Rust 1852 用例，含本批新增 176 条闸门级测试）。

完整历史见 [CHANGELOG](https://github.com/wuxiran/cc-pane/blob/main/CHANGELOG.md)。

## 新增（Added）

- **checkpoint+delta 终端恢复（M3b）**：前端定期给终端屏幕拍照（SerializeAddon）上传 daemon，恢复时回放「照片+增量」而非 8MB 字节环。长会话不再线性吃 daemon 内存、恢复深度不再受 8MB 上限、死会话恢复带完整画面语义。旧 daemon 优雅降级（能力探测 + 旧回放路径）。
- **按视图的可见性单源**：星标镜像、弹出窗口、SelfChat、移动原型都上报真实可见性——看着星标镜像时原标签不再休眠；主窗口切走时弹出的终端不再冻结。
- **后台注意红点**：后台 agent 出错/等输入时标签亮红点，切到即清。
- **忙碌 agent 关闭确认**：关闭正在运行/等输入的 agent 标签先弹逐项确认；纯 shell 静默关。撤销重开现在也恢复浏览器标签（URL）和编辑器标签（文件路径）。
- **输入感知休眠**：对工作中 agent 打字会阻止休眠（草稿保护）；回答权限提示不会（分段归因，Orca 同款）。
- 快照差集真杀开关（默认关）+ 修复后的观察链：保护集与孤儿 GC 同源、来源不可达即放弃本轮、悬挂候选 60s 过期。

## 变更（Changed）

- **销毁路径归一**：全部 7 条关标签路径走同一管线 + 显式策略矩阵；6 个散落出口删除；**killSession 调用点有 CI 白名单护栏守着**（本次真的加上了）。
- **恢复读路径 5→1**：attach/崩溃恢复/desync 重放/溢出恢复/休眠唤醒全部读同一个结构化 `getRecoverySnapshot`。
- 轮询降级桥不再把前缀失配整屏冒充增量（会画面翻倍）——改发 desync 走快照重建。
- 边界契约表覆盖双向（daemon→app 事件 + app→daemon 消息），跨语言穷举守卫。

## 修复（Fixed）

- 拖动标签不再可能杀掉留在原 pane 的会话（树操作与销毁物理分离）。
- 删布局用含 savedSessionId 的全量杀口径（恢复中的会话不再漏成孤儿）。
- launchId 每次启动新生成（docs/69）：恢复出的会话能再次绑定 resume id，不再永久退化。
- 上下文用量缓存随会话销毁回收。

## Beta 试用注意

- **daemon 随包更新**：checkpoint 恢复与 hidden 闸门需要新 daemon。安装后建议完全退出再启动一次（更新器不杀在途会话，旧 daemon 会在无会话时自动退休）。
- 与稳定版共用数据目录，回退到 v0.11.13 安装包即可降级（数据不受影响）。

---

## macOS 安装说明

由于应用未经 Apple 签名，macOS 可能提示"文件已损坏"或"无法验证开发者"：

```bash
xattr -cr /Applications/CC-Panes.app
```

或右键点击应用选"打开"，或在"系统设置 → 隐私与安全性"点"仍要打开"。

## Linux 安装说明

```bash
sudo dpkg -i cc-panes_*.deb && sudo apt-get install -f   # Deb
chmod +x cc-panes_*.AppImage && ./cc-panes_*.AppImage    # AppImage
```

## Windows 绿色免安装版

`cc-panes_0.12.0-beta.1_x64-portable.zip` 解压即用；数据在 `%USERPROFILE%\.cc-panes\`，勿与安装版同时运行。
