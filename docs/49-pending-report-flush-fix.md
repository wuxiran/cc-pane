# 49 — worker-report 补投队列失效修复(Worker I 执行依据,0.11.0 收尾)

## 现象与日志实证(0.10.19,2026-07-24)

- `report_to_leader` 在 leader busy 时入队(`pending_worker_reports`,Rust 侧,key=leader PTY session_id),设计为 leader 状态跃迁回 Idle/WaitingInput 时由状态机 listener 边沿触发补投(`orchestrator_service.rs` ~:919-969、`pending_flush_action` :7746、`flush_pending_reports` :7760)。
- 日志证明机制全局正常(多 leader 多次成功 flush),但**长驻 Claude leader 会话**在某时点后状态机再无 Idle/WaitingInput 跃迁记录(12 小时,期间实际空闲无数次),report 时的 busy 检查恒返回 busy → 边沿永不触发 → 8 条报告全部滞留;TTL(30min,`PENDING_REPORT_TTL_SECS`)静默丢弃且无日志(观测 queue_len 3→1)。
- 疑似诱因:当天 CC-Panes 多次重启/会话重挂载后,该会话的 hook 事件流或跨通道去重(`session_state_machine.rs`)卡死,状态冻结在 Active/Thinking。连带伤害:该 tab 的 UI 状态灯长期错误。

## 修复要求

1. **补投改"边沿 + 电平"双触发**(主修,治标彻底):新增周期扫描(60s 间隔,tokio interval,app 常驻任务)遍历 `pending_worker_reports` 非空的 leader,实时查其当前状态,可投(Idle/WaitingInput)即调用现有 `flush_pending_reports`;与边沿触发共存(flush 内部 take 队列天然幂等防重)。leader 会话已不存在 → 清队并 warn。
2. **TTL 丢弃可见化**:`take_pending_reports`/插入清理时丢弃过期条目必须 warn(含 worker_id、age);丢弃时同步把对应 worker binding 的 metadata 记一笔 `reportDropped: true`(排障可查)。
3. **状态机陈旧 busy 兜底**:`session_state_machine`(或 terminal_service 状态查询侧)对 hook 驱动的 busy 类状态(Active/Thinking/ToolRunning/Compacting)加"陈旧超时"——超过阈值(如 10 分钟)无任何新 hook/OSC 事件则查询侧视为 Idle(不改存储状态,只影响 busy 判定与 pending_flush_action 的输入;阈值常量入 constants)。这同时修 UI 状态灯长期卡 busy。
4. **重挂载状态重置排查**(允许查实后小修):app 重启后 attach 既有会话时,状态机为该会话的去重/状态上下文是否残留旧 epoch 导致后续事件被误去重;若是,attach 时重置该会话的状态机上下文。
5. 测试:电平扫描在"leader 状态恒 busy 但查询含陈旧回落"下把积压投出;TTL 丢弃产生 warn 与 metadata;陈旧回落不影响真实活跃会话(有事件流时不回落);边沿+电平并发不重复投递。

## 验证

- 单测 + `cargo test -p cc-panes` bridge/orchestrator 相关。
- 手工(随 0.11.0 清单):leader 长时间连续工具调用期间 worker 完成 → 最迟 60s 内 leader 空闲时收到 [worker-report];观察 UI 状态灯不再长期卡 busy。
