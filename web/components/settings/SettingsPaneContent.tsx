import { lazy, Suspense } from "react";
import { isTauriRuntime } from "@/services/runtime";
import type { SettingsDraft } from "./settingsDraft";
import type { SettingsPaneId } from "./settingsRegistry";

const AboutSection = lazy(() => import("./AboutSection"));
const CCChanSettings = lazy(() => import("./CCChanSettings"));
const CliLaunchersSection = lazy(() => import("./CliLaunchersSection"));
const GeneralSection = lazy(() => import("./GeneralSection"));
const NotificationSection = lazy(() => import("./NotificationSection"));
const ProviderSection = lazy(() => import("./ProviderSection"));
const ProxySection = lazy(() => import("./ProxySection"));
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
    case "general":
      return (
        <GeneralSection
          value={draft.general}
          onChange={(general) => updateDraft({ ...draft, general })}
          localHistoryEnabled={draft.localHistory.enabled}
          onLocalHistoryEnabledChange={(enabled) =>
            updateDraft({ ...draft, localHistory: { enabled } })
          }
        />
      );
    case "notification":
      return <NotificationSection value={draft.notification} onChange={(notification) => updateDraft({ ...draft, notification })} />;
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
  }
}

export default function SettingsPaneContent(props: SettingsPaneContentProps) {
  return (
    <div data-settings-section={`${props.paneId}-root`} className="scroll-m-8">
      <Suspense fallback={null}>
        <Pane {...props} />
      </Suspense>
    </div>
  );
}
