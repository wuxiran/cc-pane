import { terminalService, worktreeService, type WorktreeSetupPlan } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores/usePanesStore";
import { useWorktreeSetupStore } from "@/stores/useWorktreeSetupStore";
import { waitForTabSession } from "@/lib/quickCommandExecution";
import { handleErrorSilent } from "@/utils";

export type WorktreeSetupAction = "none" | "run" | "confirm";

/** 计划 → 下一步：没有命令什么都不做；已「始终允许」直接跑；否则弹确认。 */
export function worktreeSetupAction(plan: WorktreeSetupPlan | null): WorktreeSetupAction {
  if (!plan || plan.setup.length === 0 || !plan.commandLine) return "none";
  return plan.alwaysAllowed ? "run" : "confirm";
}

/**
 * 在活动窗格开一个普通终端标签（cwd 显式为新 worktree 根），提交 setup 命令。
 * 用户在标签里能看到全部输出。
 */
export async function runWorktreeSetup(plan: WorktreeSetupPlan): Promise<void> {
  const panes = usePanesStore.getState();
  const tabId = crypto.randomUUID();
  panes.addTab(panes.activePaneId, {
    tabId,
    projectId: `worktree-setup-${tabId}`,
    projectPath: plan.worktreePath,
    providerSelection: "none",
    cliTool: "none",
    customTitle: "worktree setup",
  });
  const sessionId = await waitForTabSession(tabId);
  await terminalService.submitToSession(sessionId, plan.commandLine);
}

/**
 * worktree 创建成功后调用（不阻塞调用方，失败只记日志）：
 * 应用 copyFiles / sparseCheckout，有 setup 时按批准状态执行或排队等确认。
 */
export async function requestWorktreeSetup(worktreePath: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const plan = await worktreeService.prepareSetup(worktreePath);
    const action = worktreeSetupAction(plan);
    if (action === "run" && plan) await runWorktreeSetup(plan);
    else if (action === "confirm" && plan) useWorktreeSetupStore.getState().enqueue(plan);
  } catch (error) {
    handleErrorSilent(error, "worktree setup");
  }
}
