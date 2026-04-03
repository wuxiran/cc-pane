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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { discoverWslDistros } from "@/services/sshMachineService";
import type {
  Workspace,
  WorkspaceLaunchEnvironment,
  WslDistro,
} from "@/types";
import {
  detectAppPlatform,
  getErrorMessage,
  getWorkspaceDefaultEnvironment,
  getWorkspaceEnvironmentIssue,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  toWslPath,
} from "@/utils";

function selectClassName() {
  return "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";
}

type WorkspaceEnvironmentTranslator = TFunction<readonly ["sidebar", "common"]>;

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
  return `rounded-xl border p-4 ${active ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]" : "border-[var(--app-border)] bg-[var(--app-glass-bg)]"}`;
}

export default function WorkspaceEnvironmentPanel() {
  const { t } = useTranslation(["sidebar", "common"]);
  const workspace = useWorkspacesStore((s) => s.selectedWorkspace());
  const saveWorkspace = useWorkspacesStore((s) => s.saveWorkspace);
  const machines = useSshMachinesStore((s) => s.machines);
  const loadMachines = useSshMachinesStore((s) => s.load);

  const platform = useMemo(() => detectAppPlatform(), []);
  const isWindows = platform === "windows";

  const [localPath, setLocalPath] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslRemotePath, setWslRemotePath] = useState("");
  const [sshMachineId, setSshMachineId] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslLoading, setWslLoading] = useState(false);
  const [wslError, setWslError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    loadMachines().catch(() => {});
  }, [loadMachines]);

  const loadWslDistros = useCallback(async () => {
    if (!isWindows) return;
    setWslLoading(true);
    setWslError(null);
    try {
      setWslDistros(await discoverWslDistros());
    } catch (error) {
      setWslDistros([]);
      setWslError(getErrorMessage(error));
    } finally {
      setWslLoading(false);
    }
  }, [isWindows]);

  useEffect(() => {
    loadWslDistros().catch(() => {});
  }, [loadWslDistros]);

  useEffect(() => {
    setLocalPath(workspace?.path ?? "");
    setWslDistro(workspace?.wsl?.distro ?? "");
    setWslRemotePath(workspace?.wsl?.remotePath ?? "");
    setSshMachineId(workspace?.sshLaunch?.machineId ?? "");
    setSshRemotePath(workspace?.sshLaunch?.remotePath ?? "");
  }, [workspace]);

  const buildWorkspaceDraft = useCallback((
    source: Workspace,
    overrides?: Partial<Workspace>,
  ): Workspace => {
    const nextPath = localPath.trim();
    const nextWslDistro = wslDistro.trim();
    const nextWslRemotePath = wslRemotePath.trim();
    const nextSshMachineId = sshMachineId.trim();
    const nextSshRemotePath = sshRemotePath.trim();

    const draft: Workspace = {
      ...source,
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

    return {
      ...draft,
      ...overrides,
    };
  }, [localPath, sshMachineId, sshRemotePath, wslDistro, wslRemotePath]);

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

  const defaultEnvironment = draftWorkspace
    ? getWorkspaceDefaultEnvironment(draftWorkspace)
    : "local";

  const persistWorkspace = useCallback(async (
    key: string,
    nextWorkspace: Workspace,
    successMessage: string,
  ) => {
    setSavingKey(key);
    try {
      await saveWorkspace(nextWorkspace);
      toast.success(successMessage);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSavingKey(null);
    }
  }, [saveWorkspace]);

  const handleBrowseLocalPath = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("selectWorkspaceRoot", { ns: "sidebar", defaultValue: "选择工作空间根目录" }),
    });
    if (typeof selected === "string") {
      setLocalPath(selected);
    }
  }, [t]);

  const handleSaveEnvironment = useCallback(async (environment: WorkspaceLaunchEnvironment) => {
    if (!workspace) return;
    const nextWorkspace = buildWorkspaceDraft(workspace);
    const issue = getWorkspaceEnvironmentIssue({
      workspace: nextWorkspace,
      environment,
      machines,
      platform,
    });
    if (issue) {
      toast.error(getIssueMessage(t, issue));
      return;
    }

    await persistWorkspace(
      environment,
      nextWorkspace,
      t("workspaceEnv.saved", {
        ns: "sidebar",
        defaultValue: "{{label}} 配置已保存",
        label: getEnvironmentLabel(t, environment),
      }),
    );
  }, [buildWorkspaceDraft, machines, persistWorkspace, platform, t, workspace]);

  const handleSetDefaultEnvironment = useCallback(async (environment: WorkspaceLaunchEnvironment) => {
    if (!workspace) return;
    const nextWorkspace = buildWorkspaceDraft(workspace, { defaultEnvironment: environment });
    const issue = getWorkspaceEnvironmentIssue({
      workspace: nextWorkspace,
      environment,
      machines,
      platform,
    });
    if (issue) {
      toast.error(getIssueMessage(t, issue));
      return;
    }

    await persistWorkspace(
      `default-${environment}`,
      nextWorkspace,
      t("workspaceEnv.defaultSaved", {
        ns: "sidebar",
        defaultValue: "默认环境已切换为 {{label}}",
        label: getEnvironmentLabel(t, environment),
      }),
    );
  }, [buildWorkspaceDraft, machines, persistWorkspace, platform, t, workspace]);

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

  if (!workspace || !draftWorkspace || !environmentIssues) {
    return (
      <div className="flex h-full flex-col border-l border-[var(--app-border)] bg-[var(--app-sidebar-bg)]">
        <div className="border-b border-[var(--app-border)] px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
            {t("workspaceEnv.title", { ns: "sidebar", defaultValue: "运行环境" })}
          </p>
        </div>
        <div className="flex flex-1 items-center justify-center px-5 text-center text-sm text-[var(--app-text-secondary)]">
          {t("workspaceEnv.empty", {
            ns: "sidebar",
            defaultValue: "在左侧选中一个工作空间后，这里会显示本机 / WSL / SSH 的独立配置。",
          })}
        </div>
      </div>
    );
  }

  const currentDefaultIssue = getWorkspaceEnvironmentIssue({
    workspace: draftWorkspace,
    machines,
    platform,
  });
  const visibleEnvironments: WorkspaceLaunchEnvironment[] = isWindows
    ? ["local", "wsl", "ssh"]
    : ["local", "ssh"];

  return (
    <div className="flex h-full flex-col border-l border-[var(--app-border)] bg-[var(--app-sidebar-bg)]">
      <div className="border-b border-[var(--app-border)] px-4 py-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--app-text-tertiary)]">
          {t("workspaceEnv.title", { ns: "sidebar", defaultValue: "运行环境" })}
        </p>
        <p className="mt-1 text-sm font-semibold text-[var(--app-text-primary)]">
          {workspace.alias || workspace.name}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
            {t("workspaceEnv.defaultLabel", { ns: "sidebar", defaultValue: "默认环境" })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {visibleEnvironments.map((environment) => {
              const issue = environmentIssues[environment];
              const active = defaultEnvironment === environment;
              return (
                <Button
                  key={environment}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  disabled={!!issue || savingKey?.startsWith("default-")}
                  onClick={() => handleSetDefaultEnvironment(environment)}
                >
                  {getEnvironmentLabel(t, environment)}
                </Button>
              );
            })}
          </div>
          {currentDefaultIssue ? (
            <p className="mt-3 text-xs text-amber-500">
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

        <div className="mt-4 space-y-4">
          <section className={cardClassName(defaultEnvironment === "local")}>
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
            <div className="mt-3 space-y-3">
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
                <Button
                  size="sm"
                  onClick={() => handleSaveEnvironment("local")}
                  disabled={savingKey === "local"}
                >
                  {savingKey === "local" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("common:save", { defaultValue: "保存" })}
                </Button>
              </div>
              {environmentIssues.local ? (
                <p className="text-xs text-amber-500">{getIssueMessage(t, environmentIssues.local)}</p>
              ) : null}
            </div>
          </section>

          {isWindows ? (
            <section className={cardClassName(defaultEnvironment === "wsl")}>
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
              <div className="mt-3 space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-xs text-[var(--app-text-secondary)]">
                      {t("workspaceEnv.wslDistro", { ns: "sidebar", defaultValue: "发行版" })}
                    </label>
                    <button
                      className="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] hover:text-[var(--app-accent)]"
                      onClick={() => loadWslDistros()}
                      type="button"
                    >
                      <RefreshCw className={`h-3 w-3 ${wslLoading ? "animate-spin" : ""}`} />
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
                    <p className="mt-1 text-xs text-amber-500">{wslError}</p>
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
                  <Button
                    size="sm"
                    onClick={() => handleSaveEnvironment("wsl")}
                    disabled={savingKey === "wsl"}
                  >
                    {savingKey === "wsl" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("common:save", { defaultValue: "保存" })}
                  </Button>
                </div>
                {environmentIssues.wsl ? (
                  <p className="text-xs text-amber-500">{getIssueMessage(t, environmentIssues.wsl)}</p>
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
          ) : null}

          <section className={cardClassName(defaultEnvironment === "ssh")}>
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
            <div className="mt-3 space-y-3">
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
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => handleSaveEnvironment("ssh")}
                  disabled={savingKey === "ssh"}
                >
                  {savingKey === "ssh" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("common:save", { defaultValue: "保存" })}
                </Button>
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
                <p className="text-xs text-amber-500">{getIssueMessage(t, environmentIssues.ssh)}</p>
              ) : (
                <div className="flex items-center gap-2 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("workspaceEnv.sshHint", {
                    ns: "sidebar",
                    defaultValue: "右键工作空间时，SSH 环境会复用所选机器的连接信息。",
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
