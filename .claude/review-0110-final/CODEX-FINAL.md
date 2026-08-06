## 结论
BLOCK

## 阻断项（P0）
- `web/services/updaterService.ts:147`、`web/components/home/HomeHeader.tsx:74`、`web/components/StatusBar.tsx:87`、`web/components/settings/AboutSection.tsx:53`：这些入口都会直接走 `triggerUpdate()` / `checkForAppUpdates(true)`，最终进入 `downloadAndInstallUpdate()`；安装前会无条件停止 `cc-panes-web` / `cc-panes-daemon`。只有 `web/components/update/UpdateNotification.tsx:202` 这条卡片路径做了 `hasBusySessions()` 二次确认。触发场景是用户在有活跃会话时从状态栏、首页或 About 页点击更新，daemon 托管会话会被中断/断连，界面只看到通用“立即更新”确认，没有会话损失警告。

## 建议项（P1/P2）
- P2（发版前修：否）: `cc-cli-adapters/src/opencode.rs:28`、`cc-cli-adapters/src/opencode.rs:505`。OpenCode managed 配置写入的 5s deadline 在慢盘/网络盘/低速 WSL data_dir 上可能过紧；当前会直接硬失败并阻断 managed 启动，但错误是可见的。若本次发版要覆盖这类环境，建议把超时做成可配置或延长。

## 未核查项
- Windows host 上 `providers.json` / per-session OpenCode config / `.codex` 相关文件 ACL 未实测；源码只在 Unix 侧显式设 0600。
- Windows host 上更新安装、daemon 停止、WebView2/NSIS 行为未实测。
- 未跑构建或测试。
