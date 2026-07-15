import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Zap, Sparkles, Server } from "lucide-react";
import ProvidersPanel from "@/components/providers/ProvidersPanel";
import SharedMcpSection from "@/components/settings/SharedMcpSection";
import GlobalSkillsPanel from "./GlobalSkillsPanel";

type HubTab = "providers" | "skills" | "mcp";

/**
 * 资源中心（CC-Panes 全局资源大页面）。
 * 把原先挤在 Settings 里的 Provider、全局 Skills、共享 MCP 三块统一到一个全屏页面。
 * 三个 tab 直接复用现成/新建的管理组件，Hub 只负责外壳 + 切换。
 */
export default function ResourceHub() {
  const { t } = useTranslation(["settings", "common"]);
  const [tab, setTab] = useState<HubTab>("providers");

  const tabs: { id: HubTab; label: string; icon: React.ReactNode }[] = [
    { id: "providers", label: t("provider", { defaultValue: "Provider" }), icon: <Zap size={16} /> },
    { id: "skills", label: t("skills", { defaultValue: "Skills" }), icon: <Sparkles size={16} /> },
    { id: "mcp", label: t("sharedMcp", { defaultValue: "MCP" }), icon: <Server size={16} /> },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Hub 顶部标题 + tab 切换 */}
      <div
        className="flex items-center gap-1 px-4 shrink-0"
        style={{ height: 48, borderBottom: "1px solid var(--app-border)" }}
      >
        <span className="text-sm font-semibold mr-3" style={{ color: "var(--app-text-primary)" }}>
          {t("resourceHub", { defaultValue: "资源中心" })}
        </span>
        {tabs.map((it) => {
          const active = tab === it.id;
          return (
            <button
              key={it.id}
              onClick={() => setTab(it.id)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm transition-colors"
              style={{
                background: active ? "var(--app-activity-item-active)" : "transparent",
                color: active ? "var(--app-accent)" : "var(--app-text-secondary)",
              }}
            >
              {it.icon}
              {it.label}
            </button>
          );
        })}
      </div>

      {/* tab 内容（每个 tab 常驻挂载，用 display 切换以保留各自内部状态/滚动位置） */}
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0" style={{ display: tab === "providers" ? "block" : "none" }}>
          <ProvidersPanel />
        </div>
        <div className="absolute inset-0 overflow-y-auto" style={{ display: tab === "skills" ? "block" : "none" }}>
          <GlobalSkillsPanel />
        </div>
        <div className="absolute inset-0 overflow-y-auto" style={{ display: tab === "mcp" ? "block" : "none" }}>
          <div className="max-w-4xl mx-auto px-6 py-6">
            <SharedMcpSection />
          </div>
        </div>
      </div>
    </div>
  );
}
