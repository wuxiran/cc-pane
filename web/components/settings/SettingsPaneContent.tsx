import { Suspense } from "react";
import { isTauriRuntime } from "@/services/runtime";
import type { SettingsDraft } from "./settingsDraft";
import type { SettingsPaneId } from "./settingsRegistry";
import { cn } from "@/lib/utils";
import { lazyWithRetry } from "@/lib/lazyRetry";
import ErrorBoundary from "@/components/ErrorBoundary";

const AboutSection = lazyWithRetry(() => import("./AboutSection"), "AboutSection");
const AgentChatSection = lazyWithRetry(() => import("./AgentChatSection"), "AgentChatSection");
const SetupGuideChecklist = lazyWithRetry(() => import("@/components/onboarding/SetupGuideChecklist"), "SetupGuideChecklist");
const BrowserImportSection = lazyWithRetry(() => import("./BrowserImportSection"), "BrowserImportSection");
const CCChanSettings = lazyWithRetry(() => import("./CCChanSettings"), "CCChanSettings");
const CliLaunchersSection = lazyWithRetry(() => import("./CliLaunchersSection"), "CliLaunchersSection");
const ExperimentalSection = lazyWithRetry(() => import("./ExperimentalSection"), "ExperimentalSection");
const PrivacySection = lazyWithRetry(() => import("./PrivacySection"), "PrivacySection");
const GeneralSection = lazyWithRetry(() => import("./GeneralSection"), "GeneralSection");
const ImSection = lazyWithRetry(() => import("./ImSection"), "ImSection");
const ModulesSection = lazyWithRetry(() => import("./ModulesSection"), "ModulesSection");
const NotificationSection = lazyWithRetry(() => import("./NotificationSection"), "NotificationSection");
const PerformanceSection = lazyWithRetry(() => import("./PerformanceSection"), "PerformanceSection");
const ProxySection = lazyWithRetry(() => import("./ProxySection"), "ProxySection");
const QuickCommandsSection = lazyWithRetry(() => import("./QuickCommandsSection"), "QuickCommandsSection");
const QuickTerminalSection = lazyWithRetry(() => import("./QuickTerminalSection"), "QuickTerminalSection");
const ScreenshotSection = lazyWithRetry(() => import("./ScreenshotSection"), "ScreenshotSection");
const ShortcutsSection = lazyWithRetry(() => import("./ShortcutsSection"), "ShortcutsSection");
const TerminalSection = lazyWithRetry(() => import("./TerminalSection"), "TerminalSection");
const ThemeSection = lazyWithRetry(() => import("./ThemeSection"), "ThemeSection");
const UsageStatsSection = lazyWithRetry(() => import("./UsageStatsSettings"), "UsageStatsSection");
const VoiceSection = lazyWithRetry(() => import("./VoiceSection"), "VoiceSection");
const WallpaperSection = lazyWithRetry(() => import("./WallpaperSection"), "WallpaperSection");
const WebAccessSection = lazyWithRetry(() => import("./WebAccessSection"), "WebAccessSection");

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
    case "usage-stats":
      return <UsageStatsSection />;
    case "theme":
      return <ThemeSection view="theme" value={draft.theme} onChange={(theme) => updateDraft({ ...draft, theme })} />;
    case "theme-shape":
      return <ThemeSection view="shape" value={draft.theme} onChange={(theme) => updateDraft({ ...draft, theme })} />;
    case "notification":
      return <NotificationSection value={draft.notification} onChange={(notification) => updateDraft({ ...draft, notification })} />;
    case "im-bridge":
      return <ImSection value={draft.im} onChange={(im) => updateDraft({ ...draft, im })} />;
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
    case "browser":
      return <BrowserImportSection />;
    case "cli-launchers":
      return <CliLaunchersSection value={draft.cliLaunchers} onChange={(cliLaunchers) => updateDraft({ ...draft, cliLaunchers })} />;
    case "agent-chat":
      return (
        <AgentChatSection
          value={draft.agentChat ?? { codexForceAcp: false }}
          onChange={(agentChat) => updateDraft({ ...draft, agentChat })}
        />
      );
    case "proxy":
      return <ProxySection value={draft.proxy} onChange={(proxy) => updateDraft({ ...draft, proxy })} />;
    case "quick-commands":
      return <QuickCommandsSection />;
    case "terminal":
      return <TerminalSection value={draft.terminal} onChange={(terminal) => updateDraft({ ...draft, terminal })} />;
    case "performance":
      return (
        <PerformanceSection
          value={draft.performance}
          onChange={(performance) => updateDraft({ ...draft, performance })}
          terminal={draft.terminal}
          onTerminalChange={(terminal) => updateDraft({ ...draft, terminal })}
        />
      );
    case "quick-terminal":
      return <QuickTerminalSection value={draft.quickTerminal} onChange={(quickTerminal) => updateDraft({ ...draft, quickTerminal })} />;
    case "voice":
      return <VoiceSection value={draft.voice} onChange={(voice) => updateDraft({ ...draft, voice })} />;
    case "ccchan":
      return <CCChanSettings value={draft.ccchan} onChange={(ccchan) => updateDraft({ ...draft, ccchan })} />;
    case "shortcuts":
      return <ShortcutsSection value={draft.shortcuts} onChange={(shortcuts) => updateDraft({ ...draft, shortcuts })} />;
    case "screenshot":
      return <ScreenshotSection value={draft.screenshot} onChange={(screenshot) => updateDraft({ ...draft, screenshot })} />;
    case "wallpaper":
      return isTauriRuntime()
        ? <WallpaperSection value={draft.wallpaper} onChange={(wallpaper) => updateDraft({ ...draft, wallpaper })} />
        : null;
    case "about":
      return <AboutSection />;
    case "privacy":
      return <PrivacySection value={draft.privacy} onChange={(privacy) => updateDraft({ ...draft, privacy })} />;
    case "experimental":
      return (
        <ExperimentalSection
          value={draft.experimental}
          onChange={(experimental) => updateDraft({ ...draft, experimental })}
        />
      );
  }
}

/**
 * 已迁到 page → section → row 版式（./layout）的分区：自带 SettingsSection，外层不再套卡片。
 * 其余分区是旧版式，暂由 LegacyPane 套一张卡片 + 分区标题承载，逐个迁移后从这里加进来。
 */
const MIGRATED_PANES: ReadonlySet<SettingsPaneId> = new Set([
  "general",
  "modules",
  "theme",
  "theme-shape",
  "wallpaper",
  "terminal",
  "quick-terminal",
  "shortcuts",
  "experimental",
  "cli-launchers",
  "agent-chat",
  "quick-commands",
  "about",
  "proxy",
  "web-access",
  "notification",
  "im-bridge",
  "screenshot",
  "performance",
  "ccchan",
  "setup-guide",
  "usage-stats",
  "privacy",
]);

/** 自带卡片体系、不再套外层卡片的旧分区。 */
const OWN_CARD_LAYOUT_PANES: ReadonlySet<string> = new Set([
  "setup-guide", "resource-center", "shared-mcp", "skills",
]);
/** 需要固定高度、内部自己滚动的旧分区（列表 + 编辑器双栏）。 */
const FILLS_HEIGHT_PANES: ReadonlySet<string> = new Set(["skills"]);

interface SettingsPaneContentRenderProps extends SettingsPaneContentProps {
  /** 旧分区在多分区页里显示的小标题（单分区页由页标题承担，不重复）。 */
  legacyTitle?: string;
  legacyDescription?: string;
}

export default function SettingsPaneContent({ legacyTitle, legacyDescription, ...props }: SettingsPaneContentRenderProps) {
  const body = (
    // 分片取回失败只应炸掉这一个设置分区。没有这层边界时，throw 会一路冒泡到
    // App.tsx 顶层的 ErrorBoundary，把整个窗口换成错误页——用户看到的是「应用挂了」，
    // 而实际只是某个设置分区没加载出来。
    <ErrorBoundary key={props.paneId}>
      <Suspense fallback={null}>
        <Pane {...props} />
      </Suspense>
    </ErrorBoundary>
  );

  if (MIGRATED_PANES.has(props.paneId)) {
    return (
      <div data-settings-section={`${props.paneId}-root`} className="flex scroll-m-8 flex-col gap-7">
        {body}
      </div>
    );
  }

  const hasOwnCardLayout = OWN_CARD_LAYOUT_PANES.has(props.paneId);
  const fillsAvailableHeight = FILLS_HEIGHT_PANES.has(props.paneId);
  return (
    <section
      data-settings-section={`${props.paneId}-root`}
      data-legacy-pane={props.paneId}
      aria-label={legacyTitle}
      className="flex scroll-m-8 flex-col gap-2"
    >
      {legacyTitle ? (
        <div className="px-1">
          <h2 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-[0.04em] text-[var(--app-text-secondary)]">
            {legacyTitle}
          </h2>
          {legacyDescription ? (
            <p className="mt-0.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{legacyDescription}</p>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          "[&>div>h3:first-child]:hidden [&>div>p:first-of-type]:hidden",
          fillsAvailableHeight && "h-[min(72vh,680px)] min-h-[420px]",
          !hasOwnCardLayout && [
            "[&>div]:gap-4",
            "[&>div>div]:rounded-lg [&>div>div]:border [&>div>div]:border-[var(--app-border)] [&>div>div]:bg-[var(--app-panel-bg)] [&>div>div]:px-5 [&>div>div]:py-4",
            "[&>div>label]:rounded-lg [&>div>label]:border [&>div>label]:border-[var(--app-border)] [&>div>label]:bg-[var(--app-panel-bg)] [&>div>label]:px-5 [&>div>label]:py-4",
            "[&_label]:text-[length:var(--text-row)] [&_p]:text-[length:var(--text-small)]",
          ],
        )}
      >
        {body}
      </div>
    </section>
  );
}
