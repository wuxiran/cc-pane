import { useTranslation } from "react-i18next";
import {
  CalendarX2,
  Check,
  ChevronDown,
  ExternalLink,
  FolderKanban,
  GitBranch,
  Globe,
  Hash,
  Inbox,
  Sun,
  Terminal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TodoScope, TodoStats, TodoWorkView } from "@/types";

interface TodoViewSwitcherProps {
  viewMode: TodoWorkView;
  activeScope: TodoScope | null;
  stats?: TodoStats | null;
  onViewModeChange: (mode: TodoWorkView) => void;
  onScopeChange: (scope: TodoScope | null) => void;
}

interface ViewOption {
  key: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count?: number;
  onSelect: () => void;
}

function ViewMenuItem({ option }: { option: ViewOption }) {
  return (
    <DropdownMenuItem
      onClick={option.onSelect}
      className={option.active ? "bg-accent text-accent-foreground" : undefined}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
        {option.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.count !== undefined && (
        <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
      )}
      <Check className={`h-3.5 w-3.5 text-primary ${option.active ? "opacity-100" : "opacity-0"}`} />
    </DropdownMenuItem>
  );
}

export default function TodoViewSwitcher({
  viewMode,
  activeScope,
  stats,
  onViewModeChange,
  onScopeChange,
}: TodoViewSwitcherProps) {
  const { t } = useTranslation("dialogs");

  const selectMainView = (mode: TodoWorkView) => {
    onViewModeChange(mode);
    if (mode === "all") onScopeChange(null);
  };
  const selectScope = (scope: TodoScope) => {
    onViewModeChange("all");
    onScopeChange(scope);
  };

  const mainOptions: ViewOption[] = [
    {
      key: "all",
      label: t("todoAllTasks"),
      icon: <Hash />,
      active: viewMode === "all" && activeScope === null,
      count: stats?.total,
      onSelect: () => selectMainView("all"),
    },
    {
      key: "inbox",
      label: t("todoInbox"),
      icon: <Inbox />,
      active: viewMode === "inbox",
      count: stats?.inbox,
      onSelect: () => selectMainView("inbox"),
    },
    {
      key: "my_day",
      label: t("todoMyDay"),
      icon: <Sun />,
      active: viewMode === "my_day",
      count: stats?.myDay,
      onSelect: () => selectMainView("my_day"),
    },
    {
      key: "overdue",
      label: t("todoOverdue"),
      icon: <CalendarX2 />,
      active: viewMode === "overdue",
      count: stats?.overdue,
      onSelect: () => selectMainView("overdue"),
    },
  ];
  const scopeOptions: ViewOption[] = [
    { key: "global", label: t("todoScopeGlobal"), icon: <Globe />, active: viewMode === "all" && activeScope === "global", onSelect: () => selectScope("global") },
    { key: "workspace", label: t("todoScopeWorkspace"), icon: <FolderKanban />, active: viewMode === "all" && activeScope === "workspace", onSelect: () => selectScope("workspace") },
    { key: "project", label: t("todoScopeProject"), icon: <GitBranch />, active: viewMode === "all" && activeScope === "project", onSelect: () => selectScope("project") },
    { key: "external", label: t("todoScopeExternal"), icon: <ExternalLink />, active: viewMode === "all" && activeScope === "external", onSelect: () => selectScope("external") },
    { key: "temp_script", label: t("todoScopeScript"), icon: <Terminal />, active: viewMode === "all" && activeScope === "temp_script", onSelect: () => selectScope("temp_script") },
  ];
  const currentOption = [...mainOptions, ...scopeOptions].find((option) => option.active) ?? mainOptions[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <h1 className="truncate text-lg font-semibold">{currentOption.label}</h1>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t("todoSidebarMainViews")}</DropdownMenuLabel>
        {mainOptions.map((option) => <ViewMenuItem key={option.key} option={option} />)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("todoSidebarWorkspaces")}</DropdownMenuLabel>
        {scopeOptions.map((option) => <ViewMenuItem key={option.key} option={option} />)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
