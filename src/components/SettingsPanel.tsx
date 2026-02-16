import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Settings, Globe, Terminal, Keyboard, Info, Cloud, Bell } from "lucide-react";
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

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const sections = [
  { id: "general", label: "通用", icon: Settings },
  { id: "notification", label: "通知", icon: Bell },
  { id: "provider", label: "Provider", icon: Cloud },
  { id: "proxy", label: "代理", icon: Globe },
  { id: "terminal", label: "终端", icon: Terminal },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
  { id: "about", label: "关于", icon: Info },
];

export default function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const getDefaults = useSettingsStore((s) => s.getDefaults);

  const [draft, setDraft] = useState<AppSettings>(getDefaults());
  const [activeSection, setActiveSection] = useState("general");

  // 打开时同步设置
  useEffect(() => {
    if (open && settings) {
      setDraft(JSON.parse(JSON.stringify(settings)));
    }
  }, [open, settings]);

  async function handleSave() {
    try {
      await saveSettings(draft);
      toast.success("设置已保存");
      onOpenChange(false);
    } catch (e) {
      toast.error(`保存失败: ${e}`);
    }
  }

  function handleReset() {
    setDraft(getDefaults());
    toast.info("已恢复默认设置（需点击保存生效）");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[680px] !max-h-[520px] !p-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
          <DialogTitle>设置</DialogTitle>
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
            {activeSection === "about" && <AboutSection />}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex justify-between items-center px-5 py-3" style={{ borderTop: "1px solid var(--app-border)" }}>
          <Button variant="ghost" size="sm" onClick={handleReset}>恢复默认</Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
            <Button size="sm" onClick={handleSave}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
