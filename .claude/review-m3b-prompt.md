你是独立同行评审者。只读评审，不要改任何代码。

## 评审对象

M3b「checkpoint+delta 恢复归一」实施设计（docs/78 §4 批3 的顺延部分，全量实施前的最后一道评审）：

/mnt/d/04_workspace_rust/cc-book/.claude/plan-m3b-design.md

## 背景

仓库：/mnt/d/04_workspace_rust/cc-book（分支 feat/0120-tab-lifecycle）。
先读 docs/78-tab-lifecycle-and-recovery-rework.md 的 §1.4 与 §4（含「0.12.0
实施记录（批3 裁剪）」引用块——里面记了三条实施约束，设计声称已正面处理）。

## 请核对的代码文件（验证设计与现实的贴合度）

- cc-panes-core/src/services/terminal_service.rs（ReplayBuffer 结构、push/snapshot/shrink、dead_buffers、reader/批处理线程）
- cc-panes-daemon/src/server.rs（路由表、authorize/ensure_may_write、ControlInboundMessage、WsEmitter 引用）
- cc-panes-daemon/src/ws_emitter.rs（publish_control、hidden 闸门、desync 生成）
- src-tauri/src/services/terminal_daemon_event_bridge.rs（replay_snapshot_delta、poll_snapshot、DaemonStreamMessage）
- cc-panes-web/src/ws_handler.rs（replay_snapshot_delta 副本）
- web/services/terminalService.ts（getReplaySnapshot、registerDesync、invokeOrApi 形态）
- web/components/panes/terminalResync.ts / terminalReplay.ts / useTerminalHibernation.ts / terminalHiddenWriteBuffer.ts / terminalSessionBinding.ts
- cc-panes-core/src/services/boundary_events.rs + web/services/daemonEventContract.ts（契约表现状）
- web/components/panes/terminalBufferMode.ts（alt-strip / render flavor 相关）

## 评审维度（逐条点名）

1. **锚点方案正确性**：anchorSeq 字节锚点在多客户端（桌面+web 同时看同一
   会话、各自 alt-strip 设置不同）下是否成立？「前端已确认写入的字节 seq」
   与 daemon 侧 chunk 边界的对齐假设有没有洞（合批、flow control、web 模式
   无 endSeq 的路径）？
2. **拒收三态完备性**：stale/gap/future 之外还有没有第四种错配（如会话重建
   后 seq 归零、daemon 重启后 ReplayBuffer 重建）？
3. **兼容矩阵**：四格降级各自的实际行为是否如设计所述；有没有漏掉的组合
   （轮询降级模式 + 新 daemon、SSH 会话、in-process→daemon 切换）？
4. **批次切分与回退**：每批的「独立可验证 + 可回退」声明是否成立；M3b-4 的
   常量守门回退在已有照片存量时是否干净？
5. **测试方案可行性**：@xterm/headless 双实例逐字节一致的做法在 vitest 环境
   可行吗（无 DOM）？property test 在现有 Rust 测试基建（无 proptest 依赖？）
   怎么落地？
6. **遗漏与过度设计**：设计里有没有可以砍掉的部分（如 render_flavor 是否
   过度）或漏掉的关键路径（如休眠 wakeData 快路径与 checkpoint 的交互）？

## 输出格式（严格三段）

✅ 已确认稳妥：<点列，每条 1 行>
⚠️ 必修问题：<点列，每条标维度 + 具体文件:行号或设计章节 + 修改建议>
❓ 开放问题：<点列，每条标维度 + 选项 + 你的倾向>

不要复述设计内容，只列具体可执行的修改点。
