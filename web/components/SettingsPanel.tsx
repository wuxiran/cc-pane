import { useState, useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Settings, Globe, Terminal, Keyboard, Info, Cloud, Bell, Camera, Share2, Mic, Bot, Wifi, Cable } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores";
import type { AppSettings } from "@/types";
import GeneralSection from "./settings/GeneralSection";
import NotificationSection from "./settings/NotificationSection";
import ProviderSection from "./settings/ProviderSection";
import ProxySection from "./settings/ProxySection";
import TerminalSection from "./settings/TerminalSection";
import CliLaunchersSection from "./settings/CliLaunchersSection";
import ShortcutsSection from "./settings/ShortcutsSection";
import AboutSection from "./settings/AboutSection";
import ScreenshotSection from "./settings/ScreenshotSection";
import SharedMcpSection from "./settings/SharedMcpSection";
import VoiceSection from "./settings/VoiceSection";
import WebAccessSection from "./settings/WebAccessSection";
import CCChanSettings from "./settings/CCChanSettings";
import { DEFAULT_CCCHAN_SETTINGS, useCCChanStore } from "@/stores/useCCChanStore";
import type { CCChanSettings as CCChanSettingsValue } from "@/ccchan/types";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const getDefaults = useSettingsStore((s) => s.getDefaults);

  type SettingsDraft = AppSettings & { ccchan: CCChanSettingsValue };

  function withCCChanDraft(value: AppSettings): SettingsDraft {
    const maybeWithCCChan = value as Partial<SettingsDraft>;
    return {
      ...value,
      ccchan: {
        ...DEFAULT_CCCHAN_SETTINGS,
        ...maybeWithCCChan.ccchan,
      },
    };
  }

  const [draft, setDraft] = useState<SettingsDraft>(() => withCCChanDraft(getDefaults()));
  const [activeSection, setActiveSection] = useState("general");

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const sections = [
    { id: "general", label: t("general"), icon: Settings },
    { id: "notification", label: t("notification"), icon: Bell },
    { id: "web-access", label: "Web", icon: Wifi },
    { id: "provider", label: t("provider"), icon: Cloud },
    { id: "cli-launchers", label: t("cliLaunchers"), icon: Cable },
    { id: "proxy", label: t("proxy"), icon: Globe },
    { id: "terminal", label: t("terminal"), icon: Terminal },
    { id: "voice", label: t("voice"), icon: Mic },
    { id: "ccchan", label: "cc酱", icon: Bot },
    { id: "shortcuts", label: t("shortcuts"), icon: Keyboard },
    { id: "shared-mcp", label: "Shared MCP", icon: Share2 },
    ...(!isMac ? [{ id: "screenshot", label: t("screenshot"), icon: Camera }] : []),
    { id: "about", label: t("about"), icon: Info },
  ];

  // 打开时同步设置
  useEffect(() => {
    if (open && settings) {
      setDraft(withCCChanDraft(JSON.parse(JSON.stringify(settings))));
    }
  }, [open, settings]);

  async function handleSave() {
    try {
      const current = useSettingsStore.getState().settings;
      const settingsToSave: SettingsDraft = {
        ...draft,
        webAccess: {
          ...draft.webAccess,
          passwordSalt: current?.webAccess.passwordSalt ?? draft.webAccess.passwordSalt,
          passwordHash: current?.webAccess.passwordHash ?? draft.webAccess.passwordHash,
        },
      };
      await useCCChanStore.getState().saveSettings(draft.ccchan);
      await saveSettings(settingsToSave);
      // 推送 normalized 后的 ccchan settings 给独立的宠物窗口（未开时失败可忽略，
      // 下次显示会重新 load）。
      try {
        await emitTo("ccchan", "ccchan:settings-updated", useCCChanStore.getState().settings);
      } catch {
        /* ccchan window not open or non-Tauri runtime */
      }
      toast.success(t("saved"));
      onOpenChange(false);
    } catch (e) {
      toast.error(t("saveFailed", { ns: "common", error: e }));
    }
  }

  function handleReset() {
    setDraft(withCCChanDraft(getDefaults()));
    toast.info(t("resetDone"));
  }

  const activeSectionMeta = sections.find((s) => s.id === activeSection);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="!fixed !inset-0 !top-0 !left-0 !translate-x-0 !translate-y-0 !w-screen !h-screen !max-w-none !max-h-none !rounded-none !border-0 !p-0 !gap-0 !shadow-none data-[state=closed]:!zoom-out-100 data-[state=open]:!zoom-in-100 flex flex-col overflow-hidden"
        style={{ background: "var(--app-content)" }}
      >
        <DialogHeader
          className="flex flex-row items-center gap-3 px-6 h-[52px] shrink-0 space-y-0"
          style={{ borderBottom: "1px solid var(--app-border)", background: "var(--app-panel-bg)" }}
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-lg shrink-0"
            style={{ background: "color-mix(in srgb, var(--app-accent) 12%, transparent)", color: "var(--app-accent)" }}
          >
            <Settings size={16} />
          </span>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">{t("title")}</DialogTitle>
          <button
            type="button"
            aria-label={t("close", { ns: "common" })}
            onClick={() => onOpenChange(false)}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧导航 */}
          <nav
            className="w-[208px] px-3 py-4 flex flex-col gap-0.5 shrink-0 overflow-y-auto"
            style={{ borderRight: "1px solid var(--app-border)", background: "var(--app-panel-bg)" }}
          >
            {sections.map((section) => {
              const Icon = section.icon;
              const active = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  className="group relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-[13px] transition-colors duration-150 cursor-pointer border-none"
                  style={{
                    background: active ? "var(--app-active-bg)" : "transparent",
                    color: active ? "var(--app-accent)" : "var(--app-text-secondary)",
                    fontWeight: active ? 600 : 450,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--app-hover)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => setActiveSection(section.id)}
                >
                  {active ? (
                    <span aria-hidden="true" className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--app-accent)]" />
                  ) : null}
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{section.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 右侧内容 — 居中限宽,大屏也不拉伸 */}
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[760px] px-8 py-7">
              {activeSectionMeta ? (
                <div className="mb-5 flex items-center gap-2.5">
                  <activeSectionMeta.icon size={18} className="text-[var(--app-text-secondary)]" />
                  <h2 className="text-[17px] font-semibold tracking-tight text-[var(--app-text-primary)]">{activeSectionMeta.label}</h2>
                </div>
              ) : null}
            {activeSection === "general" && (
              <GeneralSection value={draft.general} onChange={(v) => setDraft({ ...draft, general: v })} />
            )}
            {activeSection === "notification" && (
              <NotificationSection value={draft.notification} onChange={(v) => setDraft({ ...draft, notification: v })} />
            )}
            {activeSection === "web-access" && (
              <WebAccessSection
                value={draft.webAccess}
                onChange={(v) => setDraft({ ...draft, webAccess: v })}
                orchestrator={draft.orchestrator}
                onOrchestratorChange={(v) => setDraft({ ...draft, orchestrator: v })}
              />
            )}
            {activeSection === "provider" && <ProviderSection />}
            {activeSection === "cli-launchers" && (
              <CliLaunchersSection value={draft.cliLaunchers} onChange={(v) => setDraft({ ...draft, cliLaunchers: v })} />
            )}
            {activeSection === "proxy" && (
              <ProxySection value={draft.proxy} onChange={(v) => setDraft({ ...draft, proxy: v })} />
            )}
            {activeSection === "terminal" && (
              <TerminalSection value={draft.terminal} onChange={(v) => setDraft({ ...draft, terminal: v })} />
            )}
            {activeSection === "voice" && (
              <VoiceSection value={draft.voice} onChange={(v) => setDraft({ ...draft, voice: v })} />
            )}
            {activeSection === "ccchan" && (
              <CCChanSettings value={draft.ccchan} onChange={(v) => setDraft({ ...draft, ccchan: v })} />
            )}
            {activeSection === "shortcuts" && (
              <ShortcutsSection value={draft.shortcuts} onChange={(v) => setDraft({ ...draft, shortcuts: v })} />
            )}
            {activeSection === "shared-mcp" && <SharedMcpSection />}
            {activeSection === "screenshot" && (
              <ScreenshotSection value={draft.screenshot} onChange={(v) => setDraft({ ...draft, screenshot: v })} />
            )}
            {activeSection === "about" && <AboutSection />}
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div
          className="flex justify-between items-center h-[56px] px-6 shrink-0"
          style={{ borderTop: "1px solid var(--app-border)", background: "var(--app-panel-bg)" }}
        >
          <Button variant="ghost" size="sm" onClick={handleReset}>{t("reset", { ns: "common" })}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>{t("cancel", { ns: "common" })}</Button>
            <Button size="sm" onClick={handleSave}>{t("save", { ns: "common" })}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
