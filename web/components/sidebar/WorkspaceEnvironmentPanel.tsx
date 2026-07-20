import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CheckCircle2,
  FolderSearch,
  Laptop,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Server,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/sidebar/WorkspaceDialogs";
import WorkspaceWallpaperCard from "@/components/sidebar/WorkspaceWallpaperCard";
import {
  useDialogStore,
  useEnvironmentStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import type {
  Workspace,
  WorkspaceCliEnvironmentDefaults,
  WorkspaceLaunchEnvironment,
} from "@/types";
import {
  detectAppPlatform,
  getErrorMessage,
  getWorkspaceEnvironmentIssue,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  isTauriRuntime,
  toWslPath,
} from "@/utils";

type WorkspaceEnvironmentTranslator = TFunction<readonly ["sidebar", "common"]>;
type CliDefaultEnvironment = WorkspaceLaunchEnvironment | "inherit";

interface WorkspaceEnvironmentSnapshot {
  defaultEnvironment: WorkspaceLaunchEnvironment;
  claudeDefault: CliDefaultEnvironment;
  codexDefault: CliDefaultEnvironment;
  localPath: string;
  wslDistro: string;
  wslRemotePath: string;
  sshMachineId: string;
  sshRemotePath: string;
}

function cliDefaultToEnvironment(
  value: CliDefaultEnvironment,
): WorkspaceLaunchEnvironment | undefined {
  return value === "inherit" ? undefined : value;
}

function buildCliEnvironmentDefaults(
  claudeDefault: CliDefaultEnvironment,
  codexDefault: CliDefaultEnvironment,
): WorkspaceCliEnvironmentDefaults | undefined {
  const defaults: WorkspaceCliEnvironmentDefaults = {
    claude: cliDefaultToEnvironment(claudeDefault),
    codex: cliDefaultToEnvironment(codexDefault),
  };
  return defaults.claude || defaults.codex ? defaults : undefined;
}

function selectClassName() {
  return "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";
}

function getEnvironmentLabel(
  t: WorkspaceEnvironmentTranslator,
  env: WorkspaceLaunchEnvironment,
): string {
  switch (env) {
    case "local":
      return t("workspaceEnv.local", { ns: "sidebar", defaultValue: "本机" });
    case "wsl":
      return t("workspaceEnv.wsl", { ns: "sidebar", defaultValue: "WSL" });
    case "ssh":
      return t("workspaceEnv.ssh", { ns: "sidebar", defaultValue: "SSH" });
  }
}

function getIssueMessage(
  t: WorkspaceEnvironmentTranslator,
  issue: NonNullable<ReturnType<typeof getWorkspaceEnvironmentIssue>>,
): string {
  return t(getWorkspaceLaunchIssueKey(issue), {
    ns: "sidebar",
    ...getWorkspaceLaunchIssueValues(issue),
    defaultValue: {
      "local_path_missing": "本机环境需要先设置工作空间路径。",
      "wsl_unsupported": "当前平台不支持 WSL。",
      "wsl_path_missing": "WSL 环境需要填写远端路径。",
      "wsl_local_path_missing": "WSL 环境需要先设置本机工作空间路径。",
      "ssh_machine_missing": "SSH 环境需要先选择机器。",
      "ssh_machine_not_found": "找不到已保存的 SSH 机器：{{machineId}}",
      "ssh_path_missing": "SSH 环境需要填写远端路径。",
    }[issue.code],
  });
}

function cardClassName(active: boolean) {
  return `rounded-xl border p-4 transition-colors ${active ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]" : "border-[var(--app-border)] bg-[var(--app-glass-bg)]"}`;
}

function getInitialSnapshot(workspace: Workspace): WorkspaceEnvironmentSnapshot {
  return {
    defaultEnvironment: workspace.defaultEnvironment ?? "local",
    claudeDefault: workspace.cliEnvironmentDefaults?.claude ?? "inherit",
    codexDefault: workspace.cliEnvironmentDefaults?.codex ?? "inherit",
    localPath: workspace.path ?? "",
    wslDistro: workspace.wsl?.distro ?? "",
    wslRemotePath: workspace.wsl?.remotePath ?? "",
    sshMachineId: workspace.sshLaunch?.machineId ?? "",
    sshRemotePath: workspace.sshLaunch?.remotePath ?? "",
  };
}

function snapshotsEqual(
  left: WorkspaceEnvironmentSnapshot,
  right: WorkspaceEnvironmentSnapshot,
): boolean {
  return left.defaultEnvironment === right.defaultEnvironment
    && left.claudeDefault === right.claudeDefault
    && left.codexDefault === right.codexDefault
    && left.localPath === right.localPath
    && left.wslDistro === right.wslDistro
    && left.wslRemotePath === right.wslRemotePath
    && left.sshMachineId === right.sshMachineId
    && left.sshRemotePath === right.sshRemotePath;
}

function getDefaultActiveEnvironment(
  environment: WorkspaceLaunchEnvironment,
  isWindows: boolean,
): WorkspaceLaunchEnvironment {
  if (!isWindows && environment === "wsl") {
    return "local";
  }
  return environment;
}

export default function WorkspaceEnvironmentPanel() {
  const { t } = useTranslation(["sidebar", "common"]);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const refreshWorkspace = useWorkspacesStore((state) => state.refreshWorkspace);
  const saveWorkspace = useWorkspacesStore((state) => state.saveWorkspace);
  const environmentOpen = useDialogStore((state) => state.workspaceEnvironmentOpen);
  const environmentWorkspaceId = useDialogStore((state) => state.workspaceEnvironmentWorkspaceId);
  const closeWorkspaceEnvironment = useDialogStore((state) => state.closeWorkspaceEnvironment);
  const workspace = workspaces.find((item) => item.id === environmentWorkspaceId);

  const machines = useSshMachinesStore((state) => state.machines);
  const loadMachines = useSshMachinesStore((state) => state.load);
  const { distros: wslDistros, status: wslStatus, error: wslError } = useEnvironmentStore((state) => state.wsl);
  const refreshWsl = useEnvironmentStore((state) => state.refreshWsl);

  const platform = useMemo(() => detectAppPlatform(), []);
  const isWindows = platform === "windows";

  const [defaultEnvironment, setDefaultEnvironment] = useState<WorkspaceLaunchEnvironment>("local");
  const [activeEnvironment, setActiveEnvironment] = useState<WorkspaceLaunchEnvironment>("local");
  const [claudeDefault, setClaudeDefault] = useState<CliDefaultEnvironment>("inherit");
  const [codexDefault, setCodexDefault] = useState<CliDefaultEnvironment>("inherit");
  const [localPath, setLocalPath] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslRemotePath, setWslRemotePath] = useState("");
  const [sshMachineId, setSshMachineId] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  useEffect(() => {
    if (!environmentOpen) return;
    if (!workspace) {
      closeWorkspaceEnvironment();
      return;
    }

    loadMachines().catch(() => {});
    const initial = getInitialSnapshot(workspace);
    setDefaultEnvironment(initial.defaultEnvironment);
    setActiveEnvironment(getDefaultActiveEnvironment(initial.defaultEnvironment, isWindows));
    setClaudeDefault(initial.claudeDefault);
    setCodexDefault(initial.codexDefault);
    setLocalPath(initial.localPath);
    setWslDistro(initial.wslDistro);
    setWslRemotePath(initial.wslRemotePath);
    setSshMachineId(initial.sshMachineId);
    setSshRemotePath(initial.sshRemotePath);
  }, [
    closeWorkspaceEnvironment,
    environmentOpen,
    isWindows,
    loadMachines,
    workspace?.id,
  ]);

  const buildWorkspaceDraft = useCallback((
    source: Workspace,
  ): Workspace => {
    const nextPath = localPath.trim();
    const nextWslDistro = wslDistro.trim();
    const nextWslRemotePath = wslRemotePath.trim();
    const nextSshMachineId = sshMachineId.trim();
    const nextSshRemotePath = sshRemotePath.trim();
    const cliEnvironmentDefaults = buildCliEnvironmentDefaults(
      claudeDefault,
      codexDefault,
    );

    return {
      ...source,
      defaultEnvironment,
      cliEnvironmentDefaults,
      path: nextPath || undefined,
      wsl: nextWslDistro || nextWslRemotePath
        ? {
            distro: nextWslDistro || undefined,
            remotePath: nextWslRemotePath || undefined,
          }
        : undefined,
      sshLaunch: nextSshMachineId || nextSshRemotePath
        ? {
            machineId: nextSshMachineId || undefined,
            remotePath: nextSshRemotePath || undefined,
          }
        : undefined,
    };
  }, [
    claudeDefault,
    codexDefault,
    defaultEnvironment,
    localPath,
    sshMachineId,
    sshRemotePath,
    wslDistro,
    wslRemotePath,
  ]);

  const draftWorkspace = useMemo(
    () => (workspace ? buildWorkspaceDraft(workspace) : null),
    [buildWorkspaceDraft, workspace],
  );

  const environmentIssues = useMemo(() => {
    if (!draftWorkspace) return null;
    return {
      local: getWorkspaceEnvironmentIssue({
        workspace: draftWorkspace,
        environment: "local",
        machines,
        platform,
      }),
      wsl: getWorkspaceEnvironmentIssue({
        workspace: draftWorkspace,
        environment: "wsl",
        machines,
        platform,
      }),
      ssh: getWorkspaceEnvironmentIssue({
        workspace: draftWorkspace,
        environment: "ssh",
        machines,
        platform,
      }),
    };
  }, [draftWorkspace, machines, platform]);

  const currentDefaultIssue = useMemo(() => {
    if (!draftWorkspace) return null;
    return getWorkspaceEnvironmentIssue({
      workspace: draftWorkspace,
      machines,
      platform,
    });
  }, [draftWorkspace, machines, platform]);

  const cliDefaultIssues = useMemo(() => {
    if (!environmentIssues) return { claude: null, codex: null };
    return {
      claude: claudeDefault === "inherit" ? null : environmentIssues[claudeDefault],
      codex: codexDefault === "inherit" ? null : environmentIssues[codexDefault],
    };
  }, [claudeDefault, codexDefault, environmentIssues]);

  const currentCliDefaultIssue = cliDefaultIssues.claude ?? cliDefaultIssues.codex;

  const visibleEnvironments = useMemo<WorkspaceLaunchEnvironment[]>(
    () => (isWindows ? ["local", "wsl", "ssh"] : ["local", "ssh"]),
    [isWindows],
  );

  const draftSnapshot = useMemo<WorkspaceEnvironmentSnapshot>(
    () => ({
      defaultEnvironment,
      claudeDefault,
      codexDefault,
      localPath,
      wslDistro,
      wslRemotePath,
      sshMachineId,
      sshRemotePath,
    }),
    [
      claudeDefault,
      codexDefault,
      defaultEnvironment,
      localPath,
      sshMachineId,
      sshRemotePath,
      wslDistro,
      wslRemotePath,
    ],
  );

  const isDirty = useMemo(() => {
    if (!workspace) return false;
    return !snapshotsEqual(draftSnapshot, getInitialSnapshot(workspace));
  }, [draftSnapshot, workspace]);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeWorkspaceEnvironment();
  }, [closeWorkspaceEnvironment, isDirty, saving]);

  const handleSheetOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;
    requestClose();
  }, [requestClose]);

  const handleBrowseLocalPath = useCallback(async () => {
    if (!isTauriRuntime()) {
      const selected = window.prompt(
        t("selectWorkspaceRoot", {
          ns: "sidebar",
          defaultValue: "选择工作空间根目录",
        }),
        localPath,
      );
      if (selected) {
        setLocalPath(selected);
      }
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("selectWorkspaceRoot", {
        ns: "sidebar",
        defaultValue: "选择工作空间根目录",
      }),
    });
    if (typeof selected === "string") {
      setLocalPath(selected);
    }
  }, [localPath, t]);

  const handleUseLocalPathForWsl = useCallback(() => {
    const derived = toWslPath(localPath);
    if (!derived) {
      toast.error(t("workspaceEnv.autoPathUnavailable", {
        ns: "sidebar",
        defaultValue: "当前本机路径无法自动转换成 WSL 路径。",
      }));
      return;
    }
    setWslRemotePath(derived);
  }, [localPath, t]);

  const handleSelectSshMachine = useCallback((value: string) => {
    setSshMachineId(value);
    if (sshRemotePath.trim()) return;
    const machine = machines.find((item) => item.id === value);
    if (machine?.defaultPath) {
      setSshRemotePath(machine.defaultPath);
    }
  }, [machines, sshRemotePath]);

  const handleSave = useCallback(async () => {
    if (!workspace || !draftWorkspace) return;
    if (currentDefaultIssue) {
      toast.error(getIssueMessage(t, currentDefaultIssue));
      return;
    }
    if (currentCliDefaultIssue) {
      toast.error(t("workspaceEnv.cliDefaults.invalidConfig", {
        ns: "sidebar",
        defaultValue: "CLI 默认环境有未完成配置，请先补齐配置或改为继承默认环境。",
      }));
      return;
    }

    setSaving(true);
    try {
      const latestWorkspace = await refreshWorkspace(workspace.id);
      await saveWorkspace(buildWorkspaceDraft(latestWorkspace ?? workspace));
      toast.success(t("workspaceEnv.savedAll", {
        ns: "sidebar",
        defaultValue: "运行环境配置已保存",
      }));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [
    buildWorkspaceDraft,
    currentCliDefaultIssue,
    currentDefaultIssue,
    draftWorkspace,
    refreshWorkspace,
    saveWorkspace,
    t,
    workspace,
  ]);

  const renderCliDefaultRow = (
    cliLabel: string,
    value: CliDefaultEnvironment,
    onChange: (nextValue: CliDefaultEnvironment) => void,
  ) => {
    if (!environmentIssues) return null;
    const choices: CliDefaultEnvironment[] = ["inherit", ...visibleEnvironments];
    const selectedIssue = value === "inherit" ? null : environmentIssues[value];
    const currentDefaultLabel = getEnvironmentLabel(t, defaultEnvironment);
    const inheritLabel = t("workspaceEnv.cliDefaults.inheritWith", {
      ns: "sidebar",
      environment: currentDefaultLabel,
      defaultValue: `继承默认（${currentDefaultLabel}）`,
    });

    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-[var(--app-text-secondary)]">
          {cliLabel}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {choices.map((choice) => {
            const issue = choice === "inherit" ? null : environmentIssues[choice];
            const checked = value === choice;
            const label = choice === "inherit"
              ? inheritLabel
              : getEnvironmentLabel(t, choice);
            return (
              <label
                key={choice}
                className={`flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                  checked
                    ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                    : "border-[var(--app-border)] bg-transparent text-[var(--app-text-secondary)]"
                } ${issue || saving ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <input
                  aria-label={`${cliLabel}: ${label}`}
                  checked={checked}
                  className="h-3.5 w-3.5"
                  disabled={saving || !!issue}
                  name={`workspace-cli-default-${cliLabel}`}
                  onChange={() => onChange(choice)}
                  type="radio"
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
        {selectedIssue ? (
          <p className="text-xs text-[var(--app-status-warning)]">{getIssueMessage(t, selectedIssue)}</p>
        ) : null}
      </div>
    );
  };

  const renderEnvironmentForm = () => {
    if (!environmentIssues) return null;

    switch (activeEnvironment) {
      case "local":
        return (
          <section className={cardClassName(true)}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Laptop className="h-4 w-4 text-[var(--app-accent)]" />
                <p className="text-sm font-semibold text-[var(--app-text-primary)]">
                  {t("workspaceEnv.local", { ns: "sidebar", defaultValue: "本机" })}
                </p>
              </div>
              <Badge variant={environmentIssues.local ? "outline" : "secondary"}>
                {environmentIssues.local
                  ? t("workspaceEnv.notReady", { ns: "sidebar", defaultValue: "未配置" })
                  : t("workspaceEnv.ready", { ns: "sidebar", defaultValue: "已就绪" })}
              </Badge>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.localPath", { ns: "sidebar", defaultValue: "工作空间路径" })}
                </label>
                <Input
                  value={localPath}
                  onChange={(event) => setLocalPath(event.target.value)}
                  placeholder={t("workspaceEnv.localPathPlaceholder", {
                    ns: "sidebar",
                    defaultValue: "选择一个本机目录",
                  })}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleBrowseLocalPath}>
                  <FolderSearch />
                  {t("workspaceEnv.chooseFolder", { ns: "sidebar", defaultValue: "选择目录" })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLocalPath("")}
                >
                  {t("workspaceEnv.clear", { ns: "sidebar", defaultValue: "清空" })}
                </Button>
              </div>
              {environmentIssues.local ? (
                <p className="text-xs text-[var(--app-status-warning)]">{getIssueMessage(t, environmentIssues.local)}</p>
              ) : (
                <p className="text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.localHint", {
                    ns: "sidebar",
                    defaultValue: "本机环境用于直接在当前系统路径下打开工作空间。",
                  })}
                </p>
              )}
            </div>
          </section>
        );
      case "wsl":
        return (
          <section className={cardClassName(true)}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MonitorSmartphone className="h-4 w-4 text-[var(--app-accent)]" />
                <p className="text-sm font-semibold text-[var(--app-text-primary)]">
                  {t("workspaceEnv.wsl", { ns: "sidebar", defaultValue: "WSL" })}
                </p>
              </div>
              <Badge variant={environmentIssues.wsl ? "outline" : "secondary"}>
                {environmentIssues.wsl
                  ? t("workspaceEnv.notReady", { ns: "sidebar", defaultValue: "未配置" })
                  : t("workspaceEnv.ready", { ns: "sidebar", defaultValue: "已就绪" })}
              </Badge>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs text-[var(--app-text-secondary)]">
                    {t("workspaceEnv.wslDistro", { ns: "sidebar", defaultValue: "发行版" })}
                  </label>
                  <button
                    className="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] hover:text-[var(--app-accent)]"
                    onClick={() => void refreshWsl()}
                    type="button"
                  >
                    <RefreshCw className={`h-3 w-3 ${wslStatus === "detecting" ? "animate-spin" : ""}`} />
                    {t("refresh", { ns: "sidebar", defaultValue: "刷新" })}
                  </button>
                </div>
                <select
                  className={selectClassName()}
                  value={wslDistro}
                  onChange={(event) => setWslDistro(event.target.value)}
                >
                  <option value="">
                    {t("workspaceEnv.wslDefaultDistro", {
                      ns: "sidebar",
                      defaultValue: "使用系统默认发行版",
                    })}
                  </option>
                  {wslDistros.map((distro) => (
                    <option key={distro.name} value={distro.name}>
                      {distro.name}
                    </option>
                  ))}
                </select>
                {wslError ? (
                  <p className="mt-1 text-xs text-[var(--app-status-warning)]">{wslError}</p>
                ) : null}
              </div>
              <div>
                <label className="mb-1 block text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.wslPath", { ns: "sidebar", defaultValue: "WSL 路径" })}
                </label>
                <Input
                  value={wslRemotePath}
                  onChange={(event) => setWslRemotePath(event.target.value)}
                  placeholder="/mnt/d/project"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleUseLocalPathForWsl}>
                  {t("workspaceEnv.useLocalMapping", {
                    ns: "sidebar",
                    defaultValue: "用本机路径推断",
                  })}
                </Button>
              </div>
              {environmentIssues.wsl ? (
                <p className="text-xs text-[var(--app-status-warning)]">{getIssueMessage(t, environmentIssues.wsl)}</p>
              ) : (
                <p className="text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.wslHint", {
                    ns: "sidebar",
                    defaultValue: "Claude / Codex 以 WSL 打开工作空间时，会使用这里的发行版和路径。",
                  })}
                </p>
              )}
            </div>
          </section>
        );
      case "ssh":
        return (
          <section className={cardClassName(true)}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[var(--app-accent)]" />
                <p className="text-sm font-semibold text-[var(--app-text-primary)]">
                  {t("workspaceEnv.ssh", { ns: "sidebar", defaultValue: "SSH" })}
                </p>
              </div>
              <Badge variant={environmentIssues.ssh ? "outline" : "secondary"}>
                {environmentIssues.ssh
                  ? t("workspaceEnv.notReady", { ns: "sidebar", defaultValue: "未配置" })
                  : t("workspaceEnv.ready", { ns: "sidebar", defaultValue: "已就绪" })}
              </Badge>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.sshMachine", { ns: "sidebar", defaultValue: "SSH 机器" })}
                </label>
                <select
                  className={selectClassName()}
                  value={sshMachineId}
                  onChange={(event) => handleSelectSshMachine(event.target.value)}
                >
                  <option value="">
                    {t("workspaceEnv.sshMachinePlaceholder", {
                      ns: "sidebar",
                      defaultValue: "选择一台 SSH 机器",
                    })}
                  </option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                      {machine.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.sshPath", { ns: "sidebar", defaultValue: "远端路径" })}
                </label>
                <Input
                  value={sshRemotePath}
                  onChange={(event) => setSshRemotePath(event.target.value)}
                  placeholder="/home/dev/project"
                />
              </div>
              {machines.length === 0 ? (
                <p className="text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.sshEmpty", {
                    ns: "sidebar",
                    defaultValue: "还没有 SSH 机器。先到 SSH 机器列表里新增一台。",
                  })}
                </p>
              ) : null}
              {environmentIssues.ssh ? (
                <p className="text-xs text-[var(--app-status-warning)]">{getIssueMessage(t, environmentIssues.ssh)}</p>
              ) : (
                <div className="flex items-center gap-2 text-xs text-[var(--app-status-success)]">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("workspaceEnv.sshHint", {
                    ns: "sidebar",
                    defaultValue: "右键工作空间时，SSH 环境会复用所选机器的连接信息。",
                  })}
                </div>
              )}
            </div>
          </section>
        );
    }
  };

  return (
    <>
      <Sheet open={environmentOpen && !!workspace} onOpenChange={handleSheetOpenChange}>
        <SheetContent
          side="right"
          className="w-[560px] max-w-[92vw] gap-0 border-l p-0"
        >
          {workspace ? (
            <>
              <SheetHeader className="gap-2 border-b border-[var(--app-border)] px-5 py-4 pr-12">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
                  {t("workspaceEnv.title", { ns: "sidebar", defaultValue: "运行环境" })}
                </div>
                <SheetTitle className="text-base text-[var(--app-text-primary)]">
                  {workspace.alias || workspace.name}
                </SheetTitle>
                <SheetDescription className="text-xs text-[var(--app-text-secondary)]">
                  {t("workspaceEnv.sheetHint", {
                    ns: "sidebar",
                    defaultValue: "统一管理当前工作空间的本机、WSL 和 SSH 启动配置。",
                  })}
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
                    {t("workspaceEnv.defaultLabel", { ns: "sidebar", defaultValue: "默认环境" })}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {visibleEnvironments.map((environment) => {
                      const issue = environmentIssues?.[environment];
                      const active = defaultEnvironment === environment;
                      return (
                        <Button
                          key={environment}
                          size="sm"
                          variant={active ? "default" : "outline"}
                          disabled={saving || !!issue}
                          onClick={() => setDefaultEnvironment(environment)}
                        >
                          {getEnvironmentLabel(t, environment)}
                        </Button>
                      );
                    })}
                  </div>
                  {currentDefaultIssue ? (
                    <p className="mt-3 text-xs text-[var(--app-status-warning)]">
                      {getIssueMessage(t, currentDefaultIssue)}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-[var(--app-text-secondary)]">
                      {t("workspaceEnv.defaultHint", {
                        ns: "sidebar",
                        defaultValue: "右键工作空间打开 Claude / Codex 时，会直接使用这里的默认环境。",
                      })}
                    </p>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
                      {t("workspaceEnv.cliDefaults.title", {
                        ns: "sidebar",
                        defaultValue: "CLI 默认环境",
                      })}
                    </p>
                    <p className="mt-1 text-xs text-[var(--app-text-secondary)]">
                      {t("workspaceEnv.cliDefaults.description", {
                        ns: "sidebar",
                        defaultValue: "仅影响 Claude / Codex 启动，终端继续使用工作空间默认环境。",
                      })}
                    </p>
                  </div>
                  <div className="mt-4 space-y-4">
                    {renderCliDefaultRow(
                      t("workspaceEnv.cliDefaults.claude", {
                        ns: "sidebar",
                        defaultValue: "Claude Code",
                      }),
                      claudeDefault,
                      setClaudeDefault,
                    )}
                    {renderCliDefaultRow(
                      t("workspaceEnv.cliDefaults.codex", {
                        ns: "sidebar",
                        defaultValue: "Codex CLI",
                      }),
                      codexDefault,
                      setCodexDefault,
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
                    {t("workspaceEnv.environments", {
                      ns: "sidebar",
                      defaultValue: "环境配置",
                    })}
                  </p>
                  <div className="mt-3 grid gap-2">
                    {visibleEnvironments.map((environment) => {
                      const issue = environmentIssues?.[environment];
                      const selected = activeEnvironment === environment;
                      const isDefault = defaultEnvironment === environment;
                      return (
                        <button
                          key={environment}
                          type="button"
                          className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                            selected
                              ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]"
                              : "border-[var(--app-border)] bg-[var(--app-glass-bg)] hover:border-[var(--app-accent)]/50"
                          }`}
                          onClick={() => setActiveEnvironment(environment)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-[var(--app-text-primary)]">
                                  {getEnvironmentLabel(t, environment)}
                                </span>
                                {isDefault ? (
                                  <Badge variant="secondary">
                                    {t("workspaceEnv.defaultTag", {
                                      ns: "sidebar",
                                      defaultValue: "默认",
                                    })}
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-[var(--app-text-secondary)]">
                                {issue
                                  ? getIssueMessage(t, issue)
                                  : t("workspaceEnv.readyHint", {
                                      ns: "sidebar",
                                      defaultValue: "配置完整，可直接用于启动。",
                                    })}
                              </p>
                            </div>
                            <Badge variant={issue ? "outline" : "secondary"}>
                              {issue
                                ? t("workspaceEnv.notReady", { ns: "sidebar", defaultValue: "未配置" })
                                : t("workspaceEnv.ready", { ns: "sidebar", defaultValue: "已就绪" })}
                            </Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4">
                  {renderEnvironmentForm()}
                </div>

                {/* 壁纸三态：即时保存，独立于上方 dirty 快照逻辑 */}
                <WorkspaceWallpaperCard workspace={workspace} />
              </div>

              <SheetFooter className="border-t border-[var(--app-border)] bg-[var(--app-sidebar-bg)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[var(--app-text-secondary)]">
                  {isDirty
                    ? t("workspaceEnv.unsaved", {
                        ns: "sidebar",
                        defaultValue: "有未保存的修改。",
                      })
                    : t("workspaceEnv.savedState", {
                        ns: "sidebar",
                        defaultValue: "当前配置已和磁盘同步。",
                      })}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={requestClose}>
                    {t("common:close", { defaultValue: "关闭" })}
                  </Button>
                  <Button
                    onClick={() => void handleSave()}
                    disabled={saving || !isDirty || !!currentDefaultIssue}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("workspaceEnv.saveAll", {
                      ns: "sidebar",
                      defaultValue: "保存更改",
                    })}
                  </Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={discardConfirmOpen}
        setOpen={setDiscardConfirmOpen}
        title={t("workspaceEnv.discardTitle", {
          ns: "sidebar",
          defaultValue: "放弃未保存的更改？",
        })}
        description={t("workspaceEnv.discardDescription", {
          ns: "sidebar",
          defaultValue: "当前工作空间的运行环境配置尚未保存，关闭后这些修改会丢失。",
        })}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          closeWorkspaceEnvironment();
        }}
      />
    </>
  );
}
