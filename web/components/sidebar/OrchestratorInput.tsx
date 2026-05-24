import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Bot, Check, ChevronDown, Folder, SendHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { localHistoryService } from "@/services";
import { useOrchestratorStore, useSettingsStore, useWorkspacesStore } from "@/stores";
import { handleErrorSilent } from "@/utils";
import type { Workspace, WorkspaceProject } from "@/types";
import {
  findWorkspaceProject,
  getProjectLabel,
  getProjectName,
} from "./OrchestratorTaskUtils";

const CLI_CHOICES = ["claude", "codex"] as const;

function firstProject(workspaces: Workspace[]): { workspace: Workspace; project: WorkspaceProject } | null {
  for (const workspace of workspaces) {
    if (workspace.projects.length > 0) {
      return { workspace, project: workspace.projects[0] };
    }
  }
  return null;
}

async function readGitBranch(projectPath: string): Promise<string | undefined> {
  try {
    const branch = await localHistoryService.getCurrentBranch(projectPath);
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export default function OrchestratorInput() {
  const { t } = useTranslation("sidebar");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const defaultCliTool = useSettingsStore((s) => s.settings?.general.defaultCliTool ?? "claude");
  const [cliTool, setCliTool] = useState(defaultCliTool === "codex" ? "codex" : "claude");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const create = useOrchestratorStore((s) => s.create);
  const lastTargetProjectPath = useOrchestratorStore((s) => s.lastTargetProjectPath);
  const setLastTargetProjectPath = useOrchestratorStore((s) => s.setLastTargetProjectPath);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const selectedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const selectedProjectPath = useMemo(() => {
    if (!selectedWorkspaceId || !selectedProjectId) return null;
    const workspace = workspaces.find((item) => item.id === selectedWorkspaceId);
    return workspace?.projects.find((project) => project.id === selectedProjectId)?.path ?? null;
  }, [selectedProjectId, selectedWorkspaceId, workspaces]);

  const targetProject = useMemo(() => {
    return (
      findWorkspaceProject(workspaces, lastTargetProjectPath) ??
      findWorkspaceProject(workspaces, selectedProjectPath) ??
      firstProject(workspaces)
    );
  }, [lastTargetProjectPath, selectedProjectPath, workspaces]);

  useEffect(() => {
    if (!targetProject) return;
    if (lastTargetProjectPath !== targetProject.project.path) {
      setLastTargetProjectPath(targetProject.project.path);
    }
  }, [lastTargetProjectPath, setLastTargetProjectPath, targetProject]);

  useEffect(() => {
    setCliTool(defaultCliTool === "codex" ? "codex" : "claude");
  }, [defaultCliTool]);

  const handleProjectSelect = useCallback(
    (projectPath: string) => {
      setLastTargetProjectPath(projectPath);
      setTargetOpen(false);
    },
    [setLastTargetProjectPath]
  );

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !targetProject) return;

    setSending(true);
    try {
      const gitBranch = await readGitBranch(targetProject.project.path);
      await create({
        title: text.length > 80 ? text.slice(0, 80) + "..." : text,
        prompt: text,
        projectPath: targetProject.project.path,
        workspaceName: targetProject.workspace.name,
        cliTool,
        metadata: {
          ui: {
            gitBranch,
            gitBranchCapturedAt: Date.now(),
          },
        },
      });

      setInput("");
      inputRef.current?.focus();
    } catch (e) {
      handleErrorSilent(e, "create task binding");
    } finally {
      setSending(false);
    }
  }, [cliTool, create, input, sending, targetProject]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const targetLabel = targetProject
    ? `${getProjectLabel(targetProject.project)} · ${cliTool}`
    : t("orchestrationNoProject", { defaultValue: "No project" });

  return (
    <div
      className="shrink-0 px-2 py-2"
      style={{ borderTop: "1px solid var(--app-border)" }}
    >
      <div className="mb-1.5 flex items-center">
        <Popover open={targetOpen} onOpenChange={setTargetOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-[var(--app-hover)]"
              style={{
                color: "var(--app-text-secondary)",
                border: "1px solid var(--app-border)",
              }}
              disabled={workspaces.length === 0}
              title={targetProject?.project.path}
            >
              <span className="truncate">📁 {targetLabel.replace(` · ${cliTool}`, "")}</span>
              <span className="shrink-0">· 🤖 {cliTool}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            <div className="space-y-2">
              <div>
                <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Project
                </div>
                <div className="max-h-56 overflow-y-auto pr-1">
                  {workspaces.map((workspace) => (
                    <div key={workspace.id} className="mb-1">
                      <div className="px-1 py-1 text-[11px] font-medium text-muted-foreground">
                        {workspace.alias || workspace.name}
                      </div>
                      {workspace.projects.map((project) => {
                        const selected = targetProject?.project.path === project.path;
                        return (
                          <button
                            key={project.id}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
                            onClick={() => handleProjectSelect(project.path)}
                            title={project.path}
                          >
                            <Folder className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{getProjectLabel(project)}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {getProjectName(project.path)}
                            </span>
                            {selected && <Check className="h-3.5 w-3.5 text-[var(--app-accent)]" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  CLI
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {CLI_CHOICES.map((tool) => (
                    <button
                      key={tool}
                      className="flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs transition-colors"
                      style={{
                        background: cliTool === tool ? "var(--app-accent)" : "var(--app-input-bg)",
                        color: cliTool === tool ? "white" : "var(--app-text-secondary)",
                        border: "1px solid var(--app-border)",
                      }}
                      onClick={() => setCliTool(tool)}
                    >
                      <Bot className="h-3.5 w-3.5" />
                      {tool}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div
        className="flex items-end gap-1 rounded-md px-2 py-1.5"
        style={{
          background: "var(--app-input-bg)",
          border: "1px solid var(--app-border)",
        }}
      >
        <textarea
          ref={inputRef}
          className="flex-1 resize-none border-none bg-transparent text-xs leading-relaxed outline-none"
          style={{ color: "var(--app-text-primary)", minHeight: 20, maxHeight: 80 }}
          placeholder={t("orchestrationPlaceholder", { defaultValue: "Enter task..." })}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={sending}
        />
        <button
          className="shrink-0 rounded p-1 transition-colors disabled:opacity-40"
          style={{ color: "var(--app-accent)" }}
          onClick={handleSubmit}
          disabled={!input.trim() || sending || !targetProject}
          title={t("send", { ns: "common", defaultValue: "Send" })}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
