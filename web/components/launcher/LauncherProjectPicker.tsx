// 项目选择：工作空间项目下拉 / 最近启动快捷项 / 手动目录（plugin-dialog）。
import { useEffect, useMemo, useState } from "react";
import { Clock, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { historyService, type LaunchRecord } from "@/services";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { buildLaunchRecordTerminalOptions } from "@/utils";
import type { LauncherProjectSource } from "./launcherModel";

const RECENT_FETCH = 40;
const RECENT_SHOWN = 5;

function dedupeByPath(records: LaunchRecord[], max: number): LaunchRecord[] {
  const seen = new Set<string>();
  const result: LaunchRecord[] = [];
  for (const record of records) {
    const key = record.projectPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
    if (result.length >= max) break;
  }
  return result;
}

interface LauncherProjectPickerProps {
  value: LauncherProjectSource | null;
  onChange: (source: LauncherProjectSource | null) => void;
}

export default function LauncherProjectPicker({ value, onChange }: LauncherProjectPickerProps) {
  const { t } = useTranslation("launcher");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const machines = useSshMachinesStore((s) => s.machines);
  const [records, setRecords] = useState<LaunchRecord[]>([]);

  useEffect(() => {
    let disposed = false;
    historyService
      .list(RECENT_FETCH)
      .then((list) => {
        if (!disposed) setRecords(dedupeByPath(list, RECENT_SHOWN));
      })
      .catch(() => {
        /* 历史不可用时隐藏最近区，不报错 */
      });
    return () => {
      disposed = true;
    };
  }, []);

  const selectedWorkspaceId = value?.kind === "workspace" ? value.workspaceId : "";
  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId],
  );
  const selectedProjectId = value?.kind === "workspace" ? value.projectId : "";

  function selectWorkspace(workspaceId: string) {
    if (!workspaceId) {
      onChange(null);
      return;
    }
    const workspace = workspaces.find((ws) => ws.id === workspaceId);
    const firstProject = workspace?.projects[0];
    onChange(firstProject ? { kind: "workspace", workspaceId, projectId: firstProject.id } : null);
  }

  function selectRecent(record: LaunchRecord) {
    const options = buildLaunchRecordTerminalOptions(
      record,
      useWorkspacesStore.getState().workspaces,
      machines,
    );
    onChange({ kind: "recent", options, label: record.projectName });
  }

  async function browseManual() {
    const selected = await openDirectoryDialog({
      directory: true,
      multiple: false,
      title: t("pickDirectory"),
    });
    if (typeof selected === "string" && selected) {
      onChange({ kind: "manual", path: selected });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <select
          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          value={selectedWorkspaceId}
          onChange={(event) => selectWorkspace(event.target.value)}
          aria-label={t("workspace")}
        >
          <option value="">{t("workspacePlaceholder")}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.alias || workspace.name}
            </option>
          ))}
        </select>
        <select
          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          value={selectedProjectId}
          onChange={(event) =>
            selectedWorkspaceId
            && onChange({
              kind: "workspace",
              workspaceId: selectedWorkspaceId,
              projectId: event.target.value,
            })
          }
          disabled={!selectedWorkspace}
          aria-label={t("project")}
        >
          {(selectedWorkspace?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.alias || project.path.split(/[/\\]/).pop() || project.path}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {records.map((record) => {
          const active = value?.kind === "recent" && value.options.path === record.projectPath;
          return (
            <button
              key={record.id}
              type="button"
              className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
              style={
                active
                  ? {
                      borderColor: "var(--app-accent)",
                      background: "color-mix(in srgb, var(--app-accent) 10%, transparent)",
                      color: "var(--app-accent)",
                    }
                  : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
              }
              onClick={() => selectRecent(record)}
              title={record.projectPath}
            >
              <Clock className="h-3 w-3" />
              {record.projectName}
            </button>
          );
        })}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
          style={
            value?.kind === "manual"
              ? {
                  borderColor: "var(--app-accent)",
                  background: "color-mix(in srgb, var(--app-accent) 10%, transparent)",
                  color: "var(--app-accent)",
                }
              : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
          }
          onClick={() => void browseManual()}
        >
          <FolderOpen className="h-3 w-3" />
          {value?.kind === "manual"
            ? value.path.split(/[/\\]/).pop() || value.path
            : t("browseDirectory")}
        </button>
      </div>
    </div>
  );
}
