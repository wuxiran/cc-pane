import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { localHistoryService, terminalService } from "@/services";
import {
  useActivityBarStore,
  useOrchestratorStore,
  usePanesStore,
  useTerminalStatusStore,
} from "@/stores";
import { handleErrorSilent } from "@/utils";
import type { TaskBinding } from "@/types";
import { getMetadataUi, getProjectName } from "./OrchestratorTaskUtils";

const sendQueues = new Map<string, Promise<void>>();

function enqueueSubmit(sessionId: string, text: string): Promise<void> {
  const previous = sendQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => terminalService.submitToSession(sessionId, text))
    .finally(() => {
      if (sendQueues.get(sessionId) === next) {
        sendQueues.delete(sessionId);
      }
    });
  sendQueues.set(sessionId, next);
  return next;
}

function descendantsOf(binding: TaskBinding, bindings: TaskBinding[]): TaskBinding[] {
  const result: TaskBinding[] = [];
  const visit = (parentId: string) => {
    for (const candidate of bindings) {
      if (candidate.parentId !== parentId) continue;
      result.push(candidate);
      visit(candidate.id);
    }
  };
  visit(binding.id);
  return result;
}

async function readGitBranch(projectPath: string): Promise<string | undefined> {
  try {
    const branch = await localHistoryService.getCurrentBranch(projectPath);
    return branch || undefined;
  } catch {
    return undefined;
  }
}

interface OrchestratorTaskActionsProps {
  binding: TaskBinding;
}

export default function OrchestratorTaskActions({ binding }: OrchestratorTaskActionsProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [retryLocked, setRetryLocked] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editTitle, setEditTitle] = useState(binding.title);
  const [editPrompt, setEditPrompt] = useState(binding.prompt ?? "");
  const [message, setMessage] = useState("");
  const bindings = useOrchestratorStore((s) => s.bindings);
  const create = useOrchestratorStore((s) => s.create);
  const remove = useOrchestratorStore((s) => s.remove);
  const removeCascade = useOrchestratorStore((s) => s.removeCascade);
  const update = useOrchestratorStore((s) => s.update);
  const updatePatch = useOrchestratorStore((s) => s.updatePatch);
  const setSelectedTaskId = useOrchestratorStore((s) => s.setSelectedTaskId);
  const { terminalStatus } = useTerminalStatusStore(
    useShallow((s) => ({
      // fix(C4,H5) review: 删除 CurrentToolStore，使用 TerminalStatusStore + shallow selector。
      terminalStatus: binding.sessionId ? s.statusMap.get(binding.sessionId) ?? null : null,
    }))
  );

  const descendants = useMemo(() => descendantsOf(binding, bindings), [binding, bindings]);
  const isBusy = busyAction !== null;
  const canKill = (binding.status === "running" || binding.status === "waiting") && Boolean(binding.sessionId);
  const canRetry = binding.status === "failed" && !retryLocked;
  const canEdit = binding.status === "pending" || binding.status === "completed" || binding.status === "failed";
  const canSend =
    Boolean(binding.sessionId) &&
    (terminalStatus?.status === "idle" || terminalStatus?.status === "waitingInput");
  const muted = getMetadataUi(binding).muted === true;

  useEffect(() => {
    if (!retryLocked) return;
    // fix(C5) review: retry 锁用响应式 state + timeout 自动恢复，按钮立即跟随状态刷新。
    const timer = window.setTimeout(() => setRetryLocked(false), 5000);
    return () => window.clearTimeout(timer);
  }, [retryLocked]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<void>) => {
      if (busyAction) return;
      setBusyAction(name);
      try {
        await action();
      } catch (error) {
        if (name === "retry") {
          // fix(C5) review: retry 失败立即解锁，避免异常后 5s 内误锁死。
          setRetryLocked(false);
        }
        handleErrorSilent(error, `orchestrator ${name}`);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction]
  );

  const openDetails = useCallback(() => {
    setSelectedTaskId(binding.id);
    useActivityBarStore.getState().openOrchestrationOverlay();
  }, [binding.id, setSelectedTaskId]);

  const killSession = useCallback(async () => {
    if (!binding.sessionId) return;
    await terminalService.killIdempotent(binding.sessionId);
    await updatePatch(binding.id, {
      status: "failed",
      progress: binding.progress,
      completionSummary: "Killed by user",
    });
  }, [binding.id, binding.progress, binding.sessionId, updatePatch]);

  const retryTask = useCallback(async () => {
    if (!canRetry || isBusy) return;
    setRetryLocked(true);
    await runAction("retry", async () => {
      const gitBranch = await readGitBranch(binding.projectPath);
      await updatePatch(binding.id, {
        metadata: {
          ui: {
            retriedAt: Date.now(),
          },
        },
      });
      const next = await create({
        title: binding.title,
        role: binding.role,
        parentId: binding.parentId,
        planPath: binding.planPath,
        normalizedPlanPath: binding.normalizedPlanPath,
        prompt: binding.prompt,
        projectPath: binding.projectPath,
        workspaceName: binding.workspaceName,
        cliTool: binding.cliTool,
        metadata: {
          ui: {
            retryOf: binding.id,
            gitBranch,
            startedAt: Date.now(),
          },
        },
      });
      const sessionId = await terminalService.createSession({
        projectPath: binding.projectPath,
        workspaceName: binding.workspaceName,
        cols: 120,
        rows: 30,
        cliTool: binding.cliTool,
        launchClaude: binding.cliTool !== "none",
      });
      const panes = usePanesStore.getState();
      const pane = panes.activePane() ?? panes.allPanels()[0];
      if (pane) {
        panes.addTab(pane.id, {
          projectId: `retry-${next.id}`,
          projectPath: binding.projectPath,
          sessionId,
          workspaceName: binding.workspaceName,
          cliTool: binding.cliTool,
          customTitle: binding.title,
        });
      }
      await updatePatch(next.id, {
        status: "running",
        progress: 30,
      });
      await update(next.id, { sessionId });
      if (binding.prompt?.trim()) {
        await terminalService.submitToSession(sessionId, binding.prompt.trim());
      }
    });
  }, [binding, canRetry, create, isBusy, runAction, update, updatePatch]);

  const saveEdit = useCallback(async () => {
    await runAction("edit", async () => {
      await updatePatch(binding.id, {
        title: editTitle.trim() || binding.title,
        prompt: editPrompt,
      });
      setEditOpen(false);
    });
  }, [binding.id, binding.title, editPrompt, editTitle, runAction, updatePatch]);

  const sendMessage = useCallback(async () => {
    const text = message.trim();
    if (!binding.sessionId || !text || !canSend) return;
    await runAction("send", async () => {
      await enqueueSubmit(binding.sessionId!, text);
      setMessage("");
      setSendOpen(false);
    });
  }, [binding.sessionId, canSend, message, runAction]);

  const muteTask = useCallback(async () => {
    await runAction("mute", async () => {
      await updatePatch(binding.id, {
        metadata: {
          ui: {
            muted: true,
          },
        },
      });
    });
  }, [binding.id, runAction, updatePatch]);

  const deleteTask = useCallback(async () => {
    await runAction("delete", async () => {
      if (descendants.length > 0) {
        await removeCascade(binding.id);
      } else {
        await remove(binding.id);
      }
      setDeleteOpen(false);
    });
  }, [binding.id, descendants.length, remove, removeCascade, runAction]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--app-hover)] group-hover:opacity-100"
            onClick={(event) => event.stopPropagation()}
            title="Actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" style={{ color: "var(--app-text-tertiary)" }} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={openDetails}>📄 Details</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!canKill || isBusy}
            onClick={() => runAction("kill", killSession)}
          >
            🔪 Kill
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canRetry || isBusy} onClick={retryTask}>
            🔄 Retry
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canEdit || isBusy}
            onSelect={(event) => {
              event.preventDefault();
              setEditTitle(binding.title);
              setEditPrompt(binding.prompt ?? "");
              setEditOpen(true);
            }}
          >
            ✏️ Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canSend || isBusy}
            onSelect={(event) => {
              event.preventDefault();
              setSendOpen(true);
            }}
          >
            💬 Send message
          </DropdownMenuItem>
          <DropdownMenuItem disabled={muted || isBusy} onClick={muteTask}>
            🔕 Mute
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={isBusy}
            onSelect={(event) => {
              event.preventDefault();
              if (descendants.length > 0) {
                setDeleteOpen(true);
              } else {
                void deleteTask();
              }
            }}
          >
            🗑 Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
            <textarea
              className="min-h-28 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={isBusy}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Send message</DialogTitle>
          </DialogHeader>
          <textarea
            className="min-h-28 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={`Message to ${getProjectName(binding.projectPath)}`}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)}>
              Cancel
            </Button>
            <Button onClick={sendMessage} disabled={!message.trim() || !canSend || isBusy}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete leader and workers</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p style={{ color: "var(--app-text-secondary)" }}>
              This will delete {descendants.length} worker task{descendants.length === 1 ? "" : "s"}.
            </p>
            <div className="max-h-44 overflow-y-auto rounded border p-2">
              {descendants.map((child) => (
                <div key={child.id} className="flex items-center gap-2 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  <span style={{ color: "var(--app-text-tertiary)" }}>{child.status}</span>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteTask} disabled={isBusy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
