import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Settings, Globe, Terminal, Keyboard, Info, Cloud, Bell, Camera } from "lucide-react";
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
import ShortcutsSection from "./settings/ShortcutsSection";
import AboutSection from "./settings/AboutSection";
import ScreenshotSection from "./settings/ScreenshotSection";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const getDefaults = useSettingsStore((s) => s.getDefaults);

  const [draft, setDraft] = useState<AppSettings>(getDefaults());
  const [activeSection, setActiveSection] = useState("general");

  const sections = [
    { id: "general", label: t("general"), icon: Settings },
    { id: "notification", label: t("notification"), icon: Bell },
    { id: "provider", label: t("provider"), icon: Cloud },
    { id: "proxy", label: t("proxy"), icon: Globe },
    { id: "terminal", label: t("terminal"), icon: Terminal },
    { id: "shortcuts", label: t("shortcuts"), icon: Keyboard },
    { id: "screenshot", label: t("screenshot"), icon: Camera },
    { id: "about", label: t("about"), icon: Info },
  ];

  // 打开时同步设置
  useEffect(() => {
    if (open && settings) {
      setDraft(JSON.parse(JSON.stringify(settings)));
    }
  }, [open, settings]);

  async function handleSave() {
    try {
      await saveSettings(draft);
      toast.success(t("saved"));
      onOpenChange(false);
    } catch (e) {
      toast.error(t("saveFailed", { ns: "common", error: e }));
    }
  }

  function handleReset() {
    setDraft(getDefaults());
    toast.info(t("resetDone"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizable className="w-[680px] h-[520px] max-w-[95vw] max-h-[90vh] !p-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧导航 */}
          <nav className="w-[140px] p-2 flex flex-col gap-0.5 shrink-0" style={{ borderRight: "1px solid var(--app-border)" }}>
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-left text-[13px] transition-all cursor-pointer border-none"
                  style={{
                    background: activeSection === section.id ? "var(--app-active-bg)" : "transparent",
                    color: activeSection === section.id ? "var(--app-accent)" : "var(--app-text-secondary)",
                    fontWeight: activeSection === section.id ? 500 : 400,
                  }}
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon size={16} />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 右侧内容 */}
          <div className="flex-1 px-5 py-4 overflow-y-auto">
            {activeSection === "general" && (
              <GeneralSection value={draft.general} onChange={(v) => setDraft({ ...draft, general: v })} />
            )}
            {activeSection === "notification" && (
              <NotificationSection value={draft.notification} onChange={(v) => setDraft({ ...draft, notification: v })} />
            )}
            {activeSection === "provider" && <ProviderSection />}
            {activeSection === "proxy" && (
              <ProxySection value={draft.proxy} onChange={(v) => setDraft({ ...draft, proxy: v })} />
            )}
            {activeSection === "terminal" && (
              <TerminalSection value={draft.terminal} onChange={(v) => setDraft({ ...draft, terminal: v })} />
            )}
            {activeSection === "shortcuts" && (
              <ShortcutsSection value={draft.shortcuts} onChange={(v) => setDraft({ ...draft, shortcuts: v })} />
            )}
            {activeSection === "screenshot" && (
              <ScreenshotSection value={draft.screenshot} onChange={(v) => setDraft({ ...draft, screenshot: v })} />
            )}
            {activeSection === "about" && <AboutSection />}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex justify-between items-center px-5 py-3" style={{ borderTop: "1px solid var(--app-border)" }}>
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
