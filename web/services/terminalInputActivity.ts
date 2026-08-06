// 轴1 输入活跃的记录入口（docs/78 批2 · B2-10）。
//
// 从 terminalService 抽出：它已触到行数棘轮，且这段逻辑（含循环依赖规避）
// 与终端 IO 本身无关。
//
// 此前键盘输入唯一的记录点是 usageStatsService.recordInputChars——只计字符数
// 做用量统计，不落时间戳、不进任何 store，所以「用户刚才有没有动过这个终端」
// 根本无从判断。

/**
 * 记一次用户键盘输入：时间戳 + 落在哪个会话状态段。
 *
 * 归段用当下的会话状态：忙碌段的输入是草稿（该挡休眠），waitingInput 段的
 * 输入是「已答完那个问题」（不该永久挡住休眠）。
 *
 * 延迟 import 避免循环依赖——两个 store 都 import 了 terminalService。
 */
export function recordTerminalInputActivity(sessionId: string): void {
  void Promise.all([
    import("@/stores/useTerminalStatusStore"),
    import("@/stores/useTerminalInputActivityStore"),
  ])
    .then(([statusMod, inputMod]) => {
      const segment = statusMod.useTerminalStatusStore.getState().getStatus(sessionId) ?? "unknown";
      inputMod.useTerminalInputActivityStore.getState().recordInput(sessionId, segment);
    })
    .catch(() => {});
}
