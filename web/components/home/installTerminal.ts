// 「安装其他 Agent」的一键安装：在应用内开一个普通 shell 标签，等 shell 起来后把安装命令提交进去。
// 打开终端本身是同步写 store 的，新标签立刻可见；PTY 会话 id 要等 TerminalView 建好会话才回填，
// 所以先按「打开前后的标签差集」认出我们的标签，再等它的 sessionId，最后等 shell 有首屏输出再提交。
import { terminalService } from "@/services";
import { usePanesStore } from "@/stores";
import { eachLayoutTree } from "@/stores/paneLayoutHelpers";
import { collectTabs, collectTerminalSessionIds } from "@/lib/paneSessions";

const SESSION_TIMEOUT_MS = 15_000;
/** shell 首屏（提示符）出现的等待上限；超时也照样提交——tty 会缓冲输入，交给 shell 读。 */
const PROMPT_TIMEOUT_MS = 8_000;
const POLL_MS = 250;

export type InstallRunResult = "sent" | "no-terminal";

function terminalTabIds(): Set<string> {
  const ids = new Set<string>();
  eachLayoutTree(usePanesStore.getState(), (_layout, tree) => {
    for (const tab of collectTabs(tree)) {
      if (tab.contentType === "terminal") ids.add(tab.id);
    }
  });
  return ids;
}

function sessionOfTab(tabId: string): string | null {
  const location = usePanesStore.getState().findTabAcrossLayouts(tabId);
  return location ? collectTerminalSessionIds(location.tab)[0] ?? null : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function shellHasOutput(sessionId: string): Promise<true | null> {
  try {
    const output = await terminalService.getRecentOutput(sessionId, 5);
    return output.lines.some((line) => line.trim() !== "") ? true : null;
  } catch {
    return null;
  }
}

/**
 * `open` 负责打开终端（同步写 store）。返回 "no-terminal" 表示没认出新开的标签或会话没起来，
 * 调用方应退回「复制命令」提示；提交本身失败会抛出。
 */
export async function runCommandInNewTerminal(open: () => void, command: string): Promise<InstallRunResult> {
  const before = terminalTabIds();
  open();
  const tabId = await waitFor(() => [...terminalTabIds()].find((id) => !before.has(id)) ?? null, SESSION_TIMEOUT_MS);
  if (!tabId) return "no-terminal";
  const sessionId = await waitFor(() => sessionOfTab(tabId), SESSION_TIMEOUT_MS);
  if (!sessionId) return "no-terminal";
  await waitFor(() => shellHasOutput(sessionId), PROMPT_TIMEOUT_MS);
  await terminalService.submitToSession(sessionId, command);
  return "sent";
}
