// 项目选择：一个可搜索的下拉。最近启动 → 各工作空间的项目 → 浏览目录…
// 取代原来「工作空间下拉 + 项目下拉 + 历史标签」三件套；每项都带路径，同名项目不再分不清。
// autoSelectRecent：打开时没有预选就默认填最近一次的项目，「启动」开箱即可点。
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Clock, Folder, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { historyService, type LaunchRecord } from "@/services";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { buildLaunchRecordTerminalOptions } from "@/utils";
import { cn } from "@/lib/utils";
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

const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() || path;

interface LauncherProjectPickerProps {
  value: LauncherProjectSource | null;
  onChange: (source: LauncherProjectSource | null) => void;
  autoSelectRecent?: boolean;
}

export default function LauncherProjectPicker({ value, onChange, autoSelectRecent }: LauncherProjectPickerProps) {
  const { t } = useTranslation("launcher");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const machines = useSshMachinesStore((s) => s.machines);
  const [records, setRecords] = useState<LaunchRecord[]>([]);
  const [open, setOpen] = useState(false);
  const autoSelected = useRef(false);

  const visibleWorkspaces = useMemo(
    () => workspaces.filter((ws) => !ws.hidden && !ws.archivedAt && ws.projects.length > 0),
    [workspaces],
  );

  function recentSource(record: LaunchRecord): LauncherProjectSource {
    const options = buildLaunchRecordTerminalOptions(record, useWorkspacesStore.getState().workspaces, machines);
    return { kind: "recent", options, label: record.projectName };
  }

  useEffect(() => {
    let disposed = false;
    historyService
      .list(RECENT_FETCH)
      .then((list) => {
        if (disposed) return;
        const recent = dedupeByPath(list, RECENT_SHOWN);
        setRecords(recent);
        if (autoSelectRecent && !autoSelected.current && !value && recent[0]) {
          autoSelected.current = true;
          onChange(recentSource(recent[0]));
        }
      })
      .catch(() => {
        /* 历史不可用时只是少了「最近」分组 */
      });
    return () => {
      disposed = true;
    };
    // 只在挂载时拉一次历史
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(() => {
    if (!value) return null;
    if (value.kind === "manual") return { name: baseName(value.path), path: value.path };
    if (value.kind === "recent") return { name: value.label, path: value.options.path };
    const workspace = workspaces.find((ws) => ws.id === value.workspaceId);
    const project = workspace?.projects.find((p) => p.id === value.projectId);
    if (!workspace || !project) return null;
    return { name: project.alias || baseName(project.path), path: project.path, workspace: workspace.alias || workspace.name };
  }, [value, workspaces]);

  function pick(source: LauncherProjectSource) {
    onChange(source);
    setOpen(false);
  }

  async function browseManual() {
    setOpen(false);
    const path = await openDirectoryDialog({ directory: true, multiple: false, title: t("pickDirectory") });
    if (typeof path === "string" && path) onChange({ kind: "manual", path });
  }

  const isActive = (source: LauncherProjectSource) => {
    if (!value || value.kind !== source.kind) return false;
    if (value.kind === "workspace" && source.kind === "workspace") return value.projectId === source.projectId;
    if (value.kind === "recent" && source.kind === "recent") return value.options.path === source.options.path;
    return false;
  };

  const row = (name: string, path: string, active: boolean, icon: React.ReactNode) => (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        <span className="block truncate font-mono text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{path}</span>
      </span>
      {active && <Check aria-hidden="true" />}
    </>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={t("sectionProject")}
          className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-sidebar)] px-3 text-left transition-colors duration-[var(--dur-fast)] hover:border-[var(--app-home-border-hover)]"
        >
          <Folder className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
          {selected ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-[length:var(--text-body)] font-medium text-[var(--app-text-primary)]">{selected.name}</span>
              <span className="min-w-0 truncate font-mono text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                {"workspace" in selected && selected.workspace ? `${selected.workspace} · ` : ""}{selected.path}
              </span>
            </span>
          ) : (
            <span className="flex-1 text-[length:var(--text-body)] text-[var(--app-text-tertiary)]">{t("pickProject")}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[length:var(--text-micro)] [&_[cmdk-group-heading]]:text-[var(--app-text-tertiary)]">
          <CommandInput placeholder={t("searchProject")} />
          <CommandList>
            <CommandEmpty>{t("noProjectMatch")}</CommandEmpty>
            {records.length > 0 && (
              <CommandGroup heading={t("recentGroup")}>
                {records.map((record) => {
                  const source = recentSource(record);
                  return (
                    <CommandItem key={record.id} value={`recent ${record.projectName} ${record.projectPath}`} onSelect={() => pick(source)}>
                      {row(record.projectName, record.projectPath, isActive(source), <Clock aria-hidden="true" />)}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {visibleWorkspaces.map((workspace) => (
              <CommandGroup key={workspace.id} heading={workspace.alias || workspace.name}>
                {workspace.projects.filter((project) => !project.archivedAt).map((project) => {
                  const source: LauncherProjectSource = { kind: "workspace", workspaceId: workspace.id, projectId: project.id };
                  const name = project.alias || baseName(project.path);
                  return (
                    <CommandItem
                      key={project.id}
                      value={`${workspace.name} ${workspace.alias ?? ""} ${name} ${project.path} ${project.id}`}
                      onSelect={() => pick(source)}
                    >
                      {row(name, project.path, isActive(source), <Folder aria-hidden="true" />)}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            <CommandGroup>
              <CommandItem value="__browse__" forceMount onSelect={() => void browseManual()} className={cn(value?.kind === "manual" && "text-[var(--app-accent)]")}>
                <FolderOpen aria-hidden="true" />
                {t("browseDirectory")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
