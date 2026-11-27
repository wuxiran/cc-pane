import { useEffect, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Cable } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { SegmentedTabs } from "@/components/ui/segmented";
import { hasAnyMcp, mcpIsolationGap, mcpProfileHints, runtimeMcpNote } from "@/lib/cliInjectionRules";
import { useExperimentalFeature } from "@/hooks/useExperimentalFeature";
import { useInjectionProfile } from "@/stores/useCliInjectionProfilesStore";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import type { LaunchProfileDraft, ResolvedMcpServer } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { EffectiveList, InlineCheck, Section } from "./launchProfileParts";
import { SECTION_IDS, isSharedMcpServerSelected } from "./launchProfileHelpers";
import { PendingAdditions } from "./LaunchProfileAddPicker";
import { pendingAdditions } from "./launchProfileAddModel";
import LaunchProfileMcpAdd from "./LaunchProfileMcpAdd";

/** WSL 只在 Windows 宿主上存在 */
const isWindowsHost = () => typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

type RemoteRuntime = "wsl" | "ssh";
const RUNTIME_NAMES: Record<RemoteRuntime, string> = { wsl: "WSL", ssh: "SSH" };

interface LaunchProfileMcpCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
  setMcpMode: (mode: LaunchProfileDraft["mcpPolicy"]["mode"]) => void;
  /** 后端启动预览里实际启用的 MCP；null = 预览未就绪 */
  effective?: readonly ResolvedMcpServer[] | null;
  effectiveStale?: boolean;
}

/** 启动档只管总策略；每个 MCP 开给哪些启动档统一在资源库改。 */
export default function LaunchProfileMcpCard({ draft, setDraft, activeTool, setMcpMode, effective, effectiveStale }: LaunchProfileMcpCardProps) {
  const { t } = useTranslation(["providers", "common", "settings"]);
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  // docs/113：实验开关关着时不渲染「只注入 hub」，字段也不会被后端读取
  const mcpHubEnabled = useExperimentalFeature("mcpHub");
  // 门控与注入形态提示都读 CLI 注入描述（docs/110 单源），不再维护 per-CLI 提示表。
  const profile = useInjectionProfile(activeTool);
  const mcpSupported = activeTool === "none" || hasAnyMcp(profile);
  const hints = mcpProfileHints(profile);
  // 启动档收窄了 MCP，但这个 CLI 挡不住它自己配置里的 server（docs/110 批 3）
  const isolationGap = mcpIsolationGap(profile, draft.mcpPolicy);
  // 运行配置本机 / WSL / SSH 通用：对这台机器实际可用的远端运行时，提示 MCP 到不了或只到一部分
  // （docs/110 批 4，读描述）。WSL 仅 Windows 宿主；SSH 仅已登记 SSH 机器时。
  const sshMachineCount = useSshMachinesStore((state) => state.machines.length);
  const loadSshMachines = useSshMachinesStore((state) => state.load);
  useEffect(() => {
    void loadSshMachines();
  }, [loadSshMachines]);
  const availableRemoteRuntimes: RemoteRuntime[] = [
    ...(isWindowsHost() ? (["wsl"] as const) : []),
    ...(sshMachineCount > 0 ? (["ssh"] as const) : []),
  ];
  const runtimeNotes = availableRemoteRuntimes.flatMap((runtime) => {
    const note = runtimeMcpNote(profile, runtime);
    return note ? [{ runtime, note }] : [];
  });
  // 刚新增 / 勾选、还没保存的共享 MCP：预览按已保存配置算，先在卡里标出来
  const sharedServers = useSharedMcpStore((state) => state.servers);
  const pending = effectiveStale
    ? pendingAdditions(
      sharedServers.filter((server) => isSharedMcpServerSelected(draft.mcpPolicy, server.name)).map((server) => server.name),
      effective,
    )
    : [];

  if (!mcpSupported) {
    return (
      <Section
        id={SECTION_IDS.mcp}
        title="MCP"
        hint={t("sectionMcpDesc")}
        icon={<Cable size={14} />}
        headerActions={<Badge variant="outline" className="text-[length:var(--text-micro)]">{t("mcpUnsupported")}</Badge>}
      >
        <div
          data-testid="mcp-unsupported"
          className="rounded-md border border-dashed border-[var(--app-border)] px-3 py-3 text-xs"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {t("mcpUnsupportedHint")}
        </div>
      </Section>
    );
  }

  return (
    <Section
      id={SECTION_IDS.mcp}
      title="MCP"
      hint={mcpDisabled ? t("mcpDisabledHint") : draft.mcpPolicy.mode === "custom" ? t("mcpCustomHint") : t("mcpDefaultHint")}
      icon={<Cable size={14} />}
      headerControl={
        <SegmentedTabs
          size="sm"
          value={draft.mcpPolicy.mode}
          onValueChange={(mode) => setMcpMode(mode)}
          items={(["default", "custom", "disabled"] as const).map((mode) => ({
            value: mode,
            label: t(`mcpMode.${mode}`),
          }))}
        />
      }
      headerActions={
        <>
        <LaunchProfileMcpAdd draft={draft} setDraft={setDraft} />
        <IconTooltipButton
          label={t("settings:resourceLibrary.openInLibrary")}
          onClick={() => openResourceLibrary("mcp")}
          data-testid="open-mcp-library"
          className="h-7 w-7"
        >
          <Boxes size={14} />
        </IconTooltipButton>
        </>
      }
    >

      {isolationGap && (
        <div
          data-testid="mcp-isolation-gap"
          role="note"
          className="mb-2 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--app-status-warning-border)",
            background: "var(--app-status-warning-bg)",
            color: "var(--app-status-warning)",
          }}
        >
          {t(`mcpIsolationGap.${isolationGap}`)}
        </div>
      )}

      {!mcpDisabled && (
        <InlineCheck
          checked={draft.mcpPolicy.includeSharedMcp}
          onCheckedChange={(next) => setDraft((current) => ({ ...current, mcpPolicy: { ...current.mcpPolicy, includeSharedMcp: next } }))}
          label={t("sharedMcpService")}
          hint={t("sharedMcpServiceDesc")}
        />
      )}

      {!mcpDisabled && mcpHubEnabled && draft.mcpPolicy.includeSharedMcp && (
        <InlineCheck
          checked={draft.mcpPolicy.useMcpHub === true}
          onCheckedChange={(next) => setDraft((current) => ({ ...current, mcpPolicy: { ...current.mcpPolicy, useMcpHub: next } }))}
          label={t("useMcpHub")}
          hint={t("useMcpHubDesc")}
        />
      )}

      {!mcpDisabled && <EffectiveList items={effective} stale={effectiveStale} testId="mcp-effective" />}
      {!mcpDisabled && <PendingAdditions names={pending} testId="mcp-pending" />}

      {/* CLI 注入形态 / 远端运行时的限制：不是要操作的东西，降为一行淡色脚注 */}
      {(hints.length > 0 || runtimeNotes.length > 0) && (
        <div className="mt-2 space-y-0.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {hints.length > 0 && (
            <div data-testid="mcp-tool-hint">
              {hints.map((hint) => t(`mcpProfileHint.${hint}`)).join(" ")}
            </div>
          )}
          {runtimeNotes.length > 0 && (
            <div data-testid="mcp-runtime-note">
              {runtimeNotes.map(({ runtime, note }) => (
                <div key={runtime}>
                  {t("mcpRuntimeNoteLine", { runtime: RUNTIME_NAMES[runtime], note: t(`mcpRuntimeNote.${note}`) })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
