import { useState, useEffect, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Settings, Globe, Terminal, Keyboard, Info, Cloud, Bell, Camera, Share2, Mic, Bot, Wifi, Cable, Image } from "lucide-react";
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
import WallpaperSection from "./settings/WallpaperSection";
import { isTauriRuntime } from "@/services/runtime";
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
      localHistory: {
        enabled: true,
        ...maybeWithCCChan.localHistory,
      },
      ccchan: {
        ...DEFAULT_CCCHAN_SETTINGS,
        ...maybeWithCCChan.ccchan,
      },
    };
  }

  const [draft, setDraft] = useState<SettingsDraft>(() => withCCChanDraft(getDefaults()));
  const [activeSection, setActiveSection] = useState("general");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  // 本次打开后用户是否编辑过：编辑过就不再用 store 回流覆盖草稿（防自动保存回写清掉输入）
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 各分区在草稿里对应的键；不在表里的分区（Provider/Shared MCP/关于）自管存储，无重置入口
  const SECTION_DRAFT_KEYS: Partial<Record<string, (keyof SettingsDraft)[]>> = {
    general: ["general", "localHistory"],
    notification: ["notification"],
    "web-access": ["webAccess", "orchestrator"],
    "cli-launchers": ["cliLaunchers"],
    proxy: ["proxy"],
    terminal: ["terminal"],
    voice: ["voice"],
    ccchan: ["ccchan"],
    shortcuts: ["shortcuts"],
    screenshot: ["screenshot"],
    wallpaper: ["wallpaper"],
  };

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const sections = [
    { id: "general", label: t("general"), icon: Settings },
    { id: "notification", label: t("notification"), icon: Bell },
    { id: "web-access", label: "Web", icon: Wifi },
    { id: "provider", label: t("provider"), icon: Cloud },
    { id: "cli-launchers", label: t("cliLaunchers"), icon: Cable },
    { id: "proxy", label: t("proxy"), icon: Globe },
    { id: "terminal", label: t("terminal"), icon: Terminal },
    // 壁纸依赖 asset 协议与本地文件系统：Web 端整块不渲染
    ...(isTauriRuntime() ? [{ id: "wallpaper", label: t("wallpaper"), icon: Image }] : []),
    { id: "voice", label: t("voice"), icon: Mic },
    { id: "ccchan", label: "cc酱", icon: Bot },
    { id: "shortcuts", label: t("shortcuts"), icon: Keyboard },
    { id: "shared-mcp", label: "Shared MCP", icon: Share2 },
    ...(!isMac ? [{ id: "screenshot", label: t("screenshot"), icon: Camera }] : []),
    { id: "about", label: t("about"), icon: Info },
  ];

  // 每次打开：清脏标记与保存状态
  useEffect(() => {
    if (open) {
      dirtyRef.current = false;
      setLastSavedAt(null);
      setResetArmed(false);
    }
  }, [open]);

  // 打开时同步设置（用户编辑过后不再覆盖，避免自动保存回流清掉正在输入的内容）
  useEffect(() => {
    if (open && settings && !dirtyRef.current) {
      setDraft(withCCChanDraft(JSON.parse(JSON.stringify(settings))));
    }
  }, [open, settings]);

  // 所有分区的编辑统一走这里：标脏 + 更新草稿（触发下方防抖自动保存）
  function updateDraft(next: SettingsDraft) {
    dirtyRef.current = true;
    setDraft(next);
  }

  async function persistDraft(current: SettingsDraft) {
    try {
      const live = useSettingsStore.getState().settings;
      const settingsToSave: SettingsDraft = {
        ...current,
        webAccess: {
          ...current.webAccess,
          passwordSalt: live?.webAccess.passwordSalt ?? current.webAccess.passwordSalt,
          passwordHash: live?.webAccess.passwordHash ?? current.webAccess.passwordHash,
        },
      };
      await useCCChanStore.getState().saveSettings(current.ccchan);
      await saveSettings(settingsToSave);
      // 推送 normalized 后的 ccchan settings 给独立的宠物窗口（未开时失败可忽略，
      // 下次显示会重新 load）。
      try {
        await emitTo("ccchan", "ccchan:settings-updated", useCCChanStore.getState().settings);
      } catch {
        /* ccchan window not open or non-Tauri runtime */
      }
      setLastSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      toast.error(t("saveFailed", { ns: "common", error: e }));
    }
  }

  // 自动保存：编辑后防抖 500ms 落盘
  useEffect(() => {
    if (!open || !dirtyRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft(draft);
    }, 500);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, open]);

  // 关闭时把未落盘的防抖保存立即冲掉，不丢最后一笔编辑
  function handleClose(nextOpen: boolean) {
    if (!nextOpen && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistDraft(draft);
    }
    onOpenChange(nextOpen);
  }

  const resettableKeys = SECTION_DRAFT_KEYS[activeSection];

  // 重置只作用于当前分区，且需两次点击确认（3 秒内），避免旧版全局一键重置的误伤
  function handleResetSection() {
    if (!resettableKeys) return;
    if (!resetArmed) {
      setResetArmed(true);
      if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
      resetArmTimerRef.current = setTimeout(() => setResetArmed(false), 3000);
      return;
    }
    if (resetArmTimerRef.current) clearTimeout(resetArmTimerRef.current);
    setResetArmed(false);
    const defaults = withCCChanDraft(getDefaults());
    const next = { ...draft };
    for (const key of resettableKeys) {
      (next as Record<string, unknown>)[key] = defaults[key];
    }
    updateDraft(next);
    toast.info(t("sectionResetDone"));
  }

  const activeSectionMeta = sections.find((s) => s.id === activeSection);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
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
            onClick={() => handleClose(false)}
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
                  className="group relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-[13px] transition-colors duration-[var(--dur-fast)] cursor-pointer border-none"
                  style={{
                    background: active ? "var(--app-active-bg)" : "transparent",
                    color: active ? "var(--app-accent)" : "var(--app-text-secondary)",
                    fontWeight: active ? 600 : 450,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--app-hover)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => {
                    setActiveSection(section.id);
                    setResetArmed(false);
                  }}
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

          {/* Provider 分区是带自有侧栏/滚动的整页面板，居中窄列会把它挤爆——全宽渲染 */}
          {activeSection === "provider" ? (
            <div className="min-w-0 flex-1 overflow-hidden">
              <ProviderSection />
            </div>
          ) : (
          <>
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
              <GeneralSection
                value={draft.general}
                onChange={(v) => updateDraft({ ...draft, general: v })}
                localHistoryEnabled={draft.localHistory.enabled}
                onLocalHistoryEnabledChange={(enabled) =>
                  updateDraft({ ...draft, localHistory: { enabled } })
                }
              />
            )}
            {activeSection === "notification" && (
              <NotificationSection value={draft.notification} onChange={(v) => updateDraft({ ...draft, notification: v })} />
            )}
            {activeSection === "web-access" && (
              <WebAccessSection
                value={draft.webAccess}
                onChange={(v) => updateDraft({ ...draft, webAccess: v })}
                orchestrator={draft.orchestrator}
                onOrchestratorChange={(v) => updateDraft({ ...draft, orchestrator: v })}
              />
            )}
            {activeSection === "cli-launchers" && (
              <CliLaunchersSection value={draft.cliLaunchers} onChange={(v) => updateDraft({ ...draft, cliLaunchers: v })} />
            )}
            {activeSection === "proxy" && (
              <ProxySection value={draft.proxy} onChange={(v) => updateDraft({ ...draft, proxy: v })} />
            )}
            {activeSection === "terminal" && (
              <TerminalSection value={draft.terminal} onChange={(v) => updateDraft({ ...draft, terminal: v })} />
            )}
            {activeSection === "voice" && (
              <VoiceSection value={draft.voice} onChange={(v) => updateDraft({ ...draft, voice: v })} />
            )}
            {activeSection === "ccchan" && (
              <CCChanSettings value={draft.ccchan} onChange={(v) => updateDraft({ ...draft, ccchan: v })} />
            )}
            {activeSection === "shortcuts" && (
              <ShortcutsSection value={draft.shortcuts} onChange={(v) => updateDraft({ ...draft, shortcuts: v })} />
            )}
            {activeSection === "shared-mcp" && <SharedMcpSection />}
            {activeSection === "screenshot" && (
              <ScreenshotSection value={draft.screenshot} onChange={(v) => updateDraft({ ...draft, screenshot: v })} />
            )}
            {activeSection === "wallpaper" && isTauriRuntime() && (
              <WallpaperSection value={draft.wallpaper} onChange={(v) => updateDraft({ ...draft, wallpaper: v })} />
            )}
            {activeSection === "about" && <AboutSection />}
            </div>
          </div>
          </>
          )}
        </div>

        {/* 底部操作：更改即时自动保存；重置仅作用于当前分区且需二次确认 */}
        <div
          className="flex justify-between items-center h-[56px] px-6 shrink-0"
          style={{ borderTop: "1px solid var(--app-border)", background: "var(--app-panel-bg)" }}
        >
          {resettableKeys ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetSection}
              className={resetArmed ? "text-[var(--destructive)] hover:text-[var(--destructive)]" : ""}
            >
              {resetArmed ? t("resetSectionConfirm") : t("resetSection")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {lastSavedAt ? t("autoSaved", { time: lastSavedAt }) : t("autoSaveHint")}
            </span>
            <Button variant="secondary" size="sm" onClick={() => handleClose(false)}>
              {t("close", { ns: "common" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
