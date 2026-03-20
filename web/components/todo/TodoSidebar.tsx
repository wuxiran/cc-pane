import { useTranslation } from "react-i18next";
import {
  ListTodo,
  Hash,
  Sun,
  Globe,
  FolderKanban,
  GitBranch,
  ExternalLink,
  Terminal,
} from "lucide-react";
import type { TodoScope } from "@/types";

interface TodoSidebarProps {
  viewMode: "all" | "my_day";
  activeScope: TodoScope | null;
  onViewModeChange: (mode: "all" | "my_day") => void;
  onScopeChange: (scope: TodoScope | null) => void;
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {children}
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-150 ${
        active
          ? "bg-primary/15 text-primary font-medium shadow-sm"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4 ${
        active
          ? "bg-primary/15 border border-primary/30"
          : "bg-muted/50"
      }`}>{icon}</span>
      <span className="text-sm truncate">{label}</span>
    </button>
  );
}

export default function TodoSidebar({
  viewMode,
  activeScope,
  onViewModeChange,
  onScopeChange,
}: TodoSidebarProps) {
  const { t } = useTranslation("dialogs");

  return (
    <aside className="w-[220px] shrink-0 border-r border-border flex flex-col bg-card">
      {/* 标题 */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 font-bold text-lg text-primary">
          <ListTodo className="w-5 h-5" />
          <span>TodoList</span>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        <SectionLabel>{t("todoSidebarMainViews")}</SectionLabel>
        <NavItem
          icon={<Hash />}
          label={t("todoAllTasks")}
          active={viewMode === "all" && activeScope === null}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange(null);
          }}
        />
        <NavItem
          icon={<Sun />}
          label={t("todoMyDay")}
          active={viewMode === "my_day"}
          onClick={() => onViewModeChange("my_day")}
        />

        <SectionLabel>{t("todoSidebarWorkspaces")}</SectionLabel>
        <NavItem
          icon={<Globe />}
          label={t("todoScopeGlobal")}
          active={viewMode === "all" && activeScope === "global"}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange("global");
          }}
        />
        <NavItem
          icon={<FolderKanban />}
          label={t("todoScopeWorkspace")}
          active={viewMode === "all" && activeScope === "workspace"}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange("workspace");
          }}
        />
        <NavItem
          icon={<GitBranch />}
          label={t("todoScopeProject")}
          active={viewMode === "all" && activeScope === "project"}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange("project");
          }}
        />
        <NavItem
          icon={<ExternalLink />}
          label={t("todoScopeExternal")}
          active={viewMode === "all" && activeScope === "external"}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange("external");
          }}
        />
        <NavItem
          icon={<Terminal />}
          label={t("todoScopeScript")}
          active={viewMode === "all" && activeScope === "temp_script"}
          onClick={() => {
            onViewModeChange("all");
            onScopeChange("temp_script");
          }}
        />
      </nav>
    </aside>
  );
}
