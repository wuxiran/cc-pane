// 资源库的侧栏：只放子页导航，内容都在主区。
import { Server, Sparkles, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sidebarSectionTitleClass } from "@/components/sidebar/sidebarStyles";
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import type { ResourceSection } from "@/types/resourceLibrary";

const SECTIONS: ReadonlyArray<{ id: ResourceSection; icon: LucideIcon; labelKey: "resourceLibrary.mcp" | "resourceLibrary.skills" }> = [
  { id: "mcp", icon: Server, labelKey: "resourceLibrary.mcp" },
  { id: "skills", icon: Sparkles, labelKey: "resourceLibrary.skills" },
];

export default function ResourceLibrarySidebar() {
  const { t } = useTranslation("settings");
  const section = useResourceLibraryStore((s) => s.section);
  const setSection = useResourceLibraryStore((s) => s.setSection);

  return (
    <nav
      aria-label={t("resourceLibrary.title")}
      data-material-surface=""
      data-testid="resource-library-sidebar"
      className="sidebar shape-surface flex h-full w-full flex-col gap-1 overflow-hidden px-2 pt-3"
      style={{ background: "var(--app-sidebar-bg)", borderRight: "1px solid var(--app-border)" }}
    >
      <h2 className={`px-2 pb-1 ${sidebarSectionTitleClass}`}>{t("resourceLibrary.title")}</h2>
      {SECTIONS.map(({ id, icon: Icon, labelKey }) => {
        const active = section === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? "page" : undefined}
            data-current={active ? "true" : undefined}
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[length:var(--text-row)] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--sidebar-accent)] data-[current=true]:bg-[var(--sidebar-accent)] data-[current=true]:text-[var(--app-text-primary)]"
            onClick={() => setSection(id)}
          >
            <Icon aria-hidden="true" size={16} className="shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
