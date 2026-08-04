import { lazy, Suspense } from "react";
import { isTauriRuntime } from "@/services/runtime";
import type { SettingsDraft } from "./settingsDraft";
import type { SettingsPaneId } from "./settingsRegistry";
import { cn } from "@/lib/utils";

const AboutSection = lazy(() => import("./AboutSection"));
const SetupGuideChecklist = lazy(() => import("@/components/onboarding/SetupGuideChecklist"));
const CCChanSettings = lazy(() => import("./CCChanSettings"));
const CliLaunchersSection = lazy(() => import("./CliLaunchersSection"));
const ExperimentalSection = lazy(() => import("./ExperimentalSection"));
const GeneralSection = lazy(() => import("./GeneralSection"));
const ModulesSection = lazy(() => import("./ModulesSection"));
const NotificationSection = lazy(() => import("./NotificationSection"));
const ProviderSection = lazy(() => import("./ProviderSection"));
const ProxySection = lazy(() => import("./ProxySection"));
const QuickCommandsSection = lazy(() => import("./QuickCommandsSection"));
const ScreenshotSection = lazy(() => import("./ScreenshotSection"));
const SharedMcpSection = lazy(() => import("./SharedMcpSection"));
const ShortcutsSection = lazy(() => import("./ShortcutsSection"));
const TerminalSection = lazy(() => import("./TerminalSection"));
const VoiceSection = lazy(() => import("./VoiceSection"));
const WallpaperSection = lazy(() => import("./WallpaperSection"));
const WebAccessSection = lazy(() => import("./WebAccessSection"));

interface SettingsPaneContentProps {
  paneId: SettingsPaneId;
  draft: SettingsDraft;
  updateDraft: (next: SettingsDraft) => void;
}

function Pane({ paneId, draft, updateDraft }: SettingsPaneContentProps) {
  switch (paneId) {
    case "setup-guide":
      return <SetupGuideChecklist />;
    case "general":
      return (
        <GeneralSection
          value={draft.general}
          onChange={(general) => updateDraft({ ...draft, general })}
          localHistoryEnabled={draft.localHistory.enabled}
          onLocalHistoryEnabledChange={(enabled) =>
            updateDraft({ ...draft, localHistory: { enabled } })
          }
          updateNotifyEnabled={draft.update.notifyEnabled}
          onUpdateNotifyEnabledChange={(notifyEnabled) =>
            updateDraft({ ...draft, update: { ...draft.update, notifyEnabled } })
          }
          featureTipsEnabled={draft.tips.enabled}
          onFeatureTipsEnabledChange={(enabled) =>
            updateDraft({ ...draft, tips: { ...draft.tips, enabled } })
          }
        />
      );
    case "notification":
      return <NotificationSection value={draft.notification} onChange={(notification) => updateDraft({ ...draft, notification })} />;
    case "modules":
      return <ModulesSection />;
    case "web-access":
      return (
        <WebAccessSection
          value={draft.webAccess}
          onChange={(webAccess) => updateDraft({ ...draft, webAccess })}
          orchestrator={draft.orchestrator}
          onOrchestratorChange={(orchestrator) => updateDraft({ ...draft, orchestrator })}
        />
      );
    case "provider":
      return <ProviderSection />;
    case "cli-launchers":
      return <CliLaunchersSection value={draft.cliLaunchers} onChange={(cliLaunchers) => updateDraft({ ...draft, cliLaunchers })} />;
    case "proxy":
      return <ProxySection value={draft.proxy} onChange={(proxy) => updateDraft({ ...draft, proxy })} />;
    case "quick-commands":
      return <QuickCommandsSection />;
    case "terminal":
      return <TerminalSection value={draft.terminal} onChange={(terminal) => updateDraft({ ...draft, terminal })} />;
    case "voice":
      return <VoiceSection value={draft.voice} onChange={(voice) => updateDraft({ ...draft, voice })} />;
    case "ccchan":
      return <CCChanSettings value={draft.ccchan} onChange={(ccchan) => updateDraft({ ...draft, ccchan })} />;
    case "shortcuts":
      return <ShortcutsSection value={draft.shortcuts} onChange={(shortcuts) => updateDraft({ ...draft, shortcuts })} />;
    case "shared-mcp":
      return <SharedMcpSection />;
    case "screenshot":
      return <ScreenshotSection value={draft.screenshot} onChange={(screenshot) => updateDraft({ ...draft, screenshot })} />;
    case "wallpaper":
      return isTauriRuntime()
        ? <WallpaperSection value={draft.wallpaper} onChange={(wallpaper) => updateDraft({ ...draft, wallpaper })} />
        : null;
    case "about":
      return <AboutSection />;
    case "experimental":
      return <ExperimentalSection />;
  }
}

export default function SettingsPaneContent(props: SettingsPaneContentProps) {
  const hasOwnCardLayout = ["setup-guide", "provider", "cli-launchers", "shared-mcp", "quick-commands", "experimental"].includes(props.paneId);
  const fillsAvailableHeight = props.paneId === "provider" || props.paneId === "quick-commands";
  return (
    <div
      data-settings-section={`${props.paneId}-root`}
      className={cn(
        "scroll-m-8 [&>div>h3:first-child]:hidden [&>div>p:first-of-type]:hidden",
        fillsAvailableHeight && "h-full min-h-0",
        !hasOwnCardLayout && [
          "[&>div]:gap-4",
          "[&>div>div]:rounded-lg [&>div>div]:border [&>div>div]:border-[var(--app-border)] [&>div>div]:bg-[var(--app-panel-bg)] [&>div>div]:px-5 [&>div>div]:py-4 [&>div>div]:shadow-sm",
          "[&>div>label]:rounded-lg [&>div>label]:border [&>div>label]:border-[var(--app-border)] [&>div>label]:bg-[var(--app-panel-bg)] [&>div>label]:px-5 [&>div>label]:py-4 [&>div>label]:shadow-sm",
          "[&_label]:text-[13px] [&_p]:text-[12px]",
        ],
      )}
    >
      <Suspense fallback={null}>
        <Pane {...props} />
      </Suspense>
    </div>
  );
}
