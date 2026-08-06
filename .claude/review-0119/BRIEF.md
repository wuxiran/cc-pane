# 审阅任务：终端输出洪水 · 低配机防护收尾（0.11.9 候选）

你是**只读评审**。不要修改任何文件、不要跑测试。读完本 brief 与 `changes.diff`（同目录），按文末格式输出结论。

## 背景

实测 v0.11.7 下 14 个挂载标签长时间运行，WebView renderer 3.8GB / 0.7 核、仅 CC-Panes 掉帧（整机 CPU 27%、dwm 0%——docs/71 §3 B 类判据）。主因：每个挂载标签的 xterm circular buffer 常驻（scrollback 20000 行 ≈ 50MB+/实例）。「后台标签不暂停输出」已在 v0.11.8 修复；本批修剩下四个洞。

**用户硬约束**：scrollback 默认 20000 不动；不许裁历史（已否决"后台收缩到 1000 行"方案）。方案参照 VS Code SerializeAddon 持久化与 orca agent hibernation。

## 四项改动

### P1 后台休眠（核心，最需要审）
- `terminalBackgroundLifecycle.ts`：隐藏后 5min 触发 Tier1（挂 WebGL）、30min 触发 Tier2（休眠）；可见时按最高档回滚。幂等，每 render 调用。
- `terminalHibernation.ts`：休眠容器——SerializeAddon.serialize() 产物 + 休眠期间追加的成品 chunk（都是 VT 流直接拼接），4MB 上限，溢出整体作废。
- `useTerminalHibernation.ts`：hook 收口休眠/唤醒状态机；`collectHibernatedOutput`（休眠态轻量订阅）；`replayHibernationWake`（唤醒回放，溢出退后端 snapshot）。
- `TerminalView.tsx`：init effect 依赖从 `[]` 改为 `[instanceEpoch]`——休眠=epoch+1 触发完整 cleanup、新一轮 effect 见 hibernatedStateRef 走轻量分支不构造；唤醒=再 +1 走完整 init，attach 分支优先回放休眠数据。
- 重点审：①epoch 重初始化与 React 19 dev 双挂载的交互；②休眠期间 exit 事件的处理（recordExit + onSessionExited 回调一次，唤醒补横幅）；③cleanup() 对 currentSessionIdRef/隐藏缓冲的清理顺序与休眠数据捕获顺序（hibernateNow 先 drain 再 bump epoch）；④镜像 tile（drivesBackendPty=false）与弹窗终端（恒可见）是否被误伤；⑤唤醒后 TUI 模式（bracketed paste/kitty/focus-report）恢复不全的风险评估。

### P2 scrollback 钳制 + 热更
- `lib/terminalScrollback.ts` 纯模块（钳 200–100000，默认 20000 不变）；TerminalSection 输入钳制；TerminalView 经 useTerminalAppearanceSync 运行时热更 `term.options.scrollback`（xterm 6 实证可热更）。
- 注意曾踩循环导入（TerminalSection 直接 import store 触发 useSettingsStore↔useWallpaperStore 模块级订阅环），已用纯模块解，请复核。

### P3 写流控全平台
- TerminalView 调用点删 `enabled: IS_WINDOWS`（机制平台无关，Windows 已稳跑多版）。

### P4 daemon/web 广播有界化 + desync 契约
- 两个 `ws_emitter.rs`：会话通道 unbounded → `mpsc::channel(256)`；溢出**绝不掐 VT 中段**——整段跳过 + 置 desynced，排空后插 `{"type":"desync"}`；exit/killed 终止性消息满时不置 desynced，daemon 侧走 control 兜底（notifier/sessionExited）。
- 桥 `terminal_daemon_event_bridge.rs`：`DaemonStreamMessage::Desync` → emit `terminal-desync`；前端 `terminalService.registerDesync` → `terminalResync.ts` reset + snapshot 重放。
- 已知约束：WS close = 合成 exit(-1)（桥 :241-244），所以不能用断连策略；旧 app 对新消息落 `Unknown` 静默忽略。
- 重点审：①deliver() 的 desync 状态机（标记先于恢复输出、锁内布尔无竞态？）；②exit 兜底链路的送达保证；③容量 256 的推导是否合理；④cc-panes-web 侧消费方（远程浏览器/移动端）收到 desync 的行为（移动端 `_parse` 未知类型返回 null 已确认不崩）。

### 附带重构（行数棘轮所迫，语义应零变化）
- `terminalReconnect.ts` / `terminalSessionBinding.ts` / `useTerminalAppearanceSync.ts`：从 TerminalView 机械抽出，请核对**行为等价**（尤其 doReconnect 的 ref 语义、bindSessionCallbacks 的注销时序、appearance effect 的依赖数组）。
- `terminalService.ts` 纯函数移入 `terminalServiceShared.ts`（isSessionClaimedError 保持 re-export，外部 import 不破坏）。

## 已验证

tsc 0 错；前端 355 文件 / 3317 测试全绿（含新增 6 个测试文件）；cargo test（emitter 14 + 桥 3）、clippy -D warnings、fmt 全过。

## 输出格式（写入你的最终回复）

1. **结论**：PASS / PASS-WITH-NITS / BLOCK
2. **阻塞项**（若有）：文件+行号+失败场景（什么输入/状态 → 什么错误后果），只报你能构造出具体失败路径的问题
3. **非阻塞建议**：最多 5 条
4. 完成后调用 `report_to_leader`（status=completed，summary=结论一行）。
