# 59. 版本更新提示（右下角卡片）

> 2026-07-25 立项。用户诉求：右下角出现版本更新提示卡片，一键更新。

## 0. 现状：能力全有，就是没人看见

| 环节 | 现状 |
|---|---|
| 更新检查 | ✅ `tauri-plugin-updater` + `updaterService.checkUpdateSilent()` 静默检查 |
| 结果存储 | ✅ `useUpdateStore`（`available` / `version` / `body`，body 即 changelog） |
| **被动露出** | ⚠️ **仅** StatusBar 里一个 `10px` 字号的小按钮（`StatusBar.tsx:170-186`）——几乎必然被忽略 |
| 主动检查 | ✅ 设置→关于，走系统原生 `ask`/`message` 弹窗（能用，但与应用视觉割裂） |
| 安装 | ✅ 真下载安装 + `relaunch()` |
| toast 基建 | ✅ `sonner` 已在 `AppShell` 挂载 |

**结论**：不是缺功能，是缺一次"看得见的告知"。整件事的工作量集中在一个组件 + 一套出现规则。

## 1. OrcaSlicer 的做法与我们的差异

OrcaSlicer 在 3D 画布**右下角**以非模态"通知贴片"提示（预设/云端 bundle 有更新时同理）；但它的**应用版本更新只是跳转 GitHub 让用户自己下载**，用户反馈常见困惑是"点了更新还是打开旧版"。

我们的处境更好：`tauri-plugin-updater` 能真正下载安装并重启。所以：

- **形态学 OrcaSlicer**：右下角、非模态、可忽略、不打断；
- **行为超过 OrcaSlicer**：主按钮是「立即更新」（真装 + 重启），不是"带你去下载页"。

## 2. 组件规格：`UpdateToast`

位置右下角，基于既有 sonner（`AppShell` 已挂 `Toaster`）或独立定位卡片二选一——**若 sonner 的默认 position 为 top-center 且被其它提示占用，则用独立卡片**避免抢位。

内容：

- 标题：`发现新版本 v{version}`（当前版本小字对照 `v{current} → v{next}`）；
- 正文：`body`（changelog）**截断到 3-4 行** + 「查看完整更新说明」展开/跳转；body 为空时降级为一句通用文案，不留空白块；
- 主按钮「立即更新」→ 复用既有 `triggerUpdate()`（下载→安装→`relaunch()`）；
- 次按钮「稍后」→ 关闭本次，进入静默期；
- 「跳过此版本」→ 该版本号永不再提（除非更高版本出现）。

状态与反馈：

- 下载/安装中：卡片**原地**转为进度态（不要关掉再弹一个），显示百分比或不确定态；
- 失败：卡片转为错误态，给出可读原因 + 「重试」+ 「去下载页」兜底（复用 `getUpdateErrorHint`）；
- 重启前提示"将关闭并重启应用"——**这条必须有**，用户可能正在跑 agent 任务。

## 3. 出现规则（沿用 docs/58 的克制原则）

- **绝不打断**：有 agent 处于 thinking/active/waitingInput 时不弹（更新会重启应用 = 杀掉在跑的活）；等回到空闲边界再弹；
- 启动后延迟 ≥ 30s 再弹（避开冷启动繁忙期）；
- 每个版本最多主动弹 **1 次/天**；点「稍后」→ 静默 24h；点「跳过此版本」→ 该版本不再弹；
- StatusBar 的小按钮**保留**作为常驻入口（卡片关掉后仍能找到）；
- 全局开关：设置→通用「有新版本时提示」（默认开）。

持久化（`~/.cc-panes/config.toml`，随 dev/release 数据目录隔离）：

```toml
[update]
notifyEnabled = true
skippedVersion = "0.11.2"
lastNotifiedAt = "2026-07-25T12:00:00Z"
```

## 4. 与 docs/58 功能提示的关系

同属"主动打扰用户"的通道，**必须共用一套闸门**（agent 运行中不弹、同一时刻只出现一个、互相不叠加）。实现上抽一个 `shouldInterrupt()` 判定给两者复用，否则两个系统各弹各的，用户会被两张卡同时糊脸。

优先级：更新提示 > 功能提示（前者有时效性与安全含义）。

## 5. 验收

1. 有更新时右下角出现卡片；点「立即更新」真的下载安装并重启；
2. agent 运行中不弹，回到空闲后才弹；
3. 「稍后」24h 内不再弹；「跳过此版本」永不再弹该版本，更高版本仍弹；
4. 关闭全局开关后完全不弹，StatusBar 入口仍在；
5. 下载失败给可读原因 + 重试 + 下载页兜底；
6. 与功能提示（docs/58）不同时出现；
7. 暗/亮色、中英双语、`prefers-reduced-motion` 各验一遍。

## 6. 工量

~0.5d（检查/安装/store/错误提示全部已存在，只做呈现层 + 出现规则 + 持久化）。若与 docs/58 的共用闸门一起做，合计 ~0.75d。

## 参考

- OrcaSlicer 右下角通知与"更新仅跳转 GitHub"的做法：<https://github.com/OrcaSlicer/OrcaSlicer/discussions/939>、<https://www.orcaslicer.com/wiki/releases/release_2_4_0>
