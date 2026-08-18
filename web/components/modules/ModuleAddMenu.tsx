import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MODULE_CONSUMERS, type ModuleId } from "@/modules/registry";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";

/**
 * 活动栏上「添加模块」的可见入口。
 *
 * 此前把模块放上活动栏的唯一手势是右键空白处——没有任何视觉提示，等同隐藏功能。
 * 这里给出一个常驻的 `+`，并且同一个面板既能加也能撤，不必再去记右键。
 *
 * 语义与 `ActivityBar` 的右键菜单严格对齐：撤下时落到 `rightDock`（模块支持时）
 * 而非 `hidden`，否则同一个操作在两处入口结果不同。
 */
export default function ModuleAddMenu() {
  const { t } = useTranslation("sidebar");
  const preferences = useModulePrefsStore((state) => state.preferences);
  const setEnabled = useModulePrefsStore((state) => state.setEnabled);
  const setPosition = useModulePrefsStore((state) => state.setPosition);

  // 只列能落到活动栏的模块；`configurable === false`（orchestration）不参与配置。
  const modules = MODULE_CONSUMERS.contextMenu.filter((module) => (
    module.configurable !== false && module.surfaces.includes("activityBar")
  ));

  if (modules.length === 0) return null;

  const toggle = (id: ModuleId, onBar: boolean) => {
    const module = modules.find((entry) => entry.id === id);
    if (!module) return;
    if (onBar) {
      // 撤下：优先退回右栏，模块不支持右栏时才隐藏。
      if (module.surfaces.includes("rightDock")) {
        setPosition(id, "rightDock");
      } else {
        setEnabled(id, false);
      }
      return;
    }
    setPosition(id, "activityBar");
    if (!preferences[id].enabled) setEnabled(id, true);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="module-add-trigger"
              aria-label={t("moduleAdd.trigger")}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--app-icon-inactive)] transition-[color,background-color,transform] duration-[var(--dur)] ease-[var(--ease-out)] hover:bg-[var(--app-activity-item-hover)] hover:text-[var(--app-icon-hover)] active:scale-[0.96]"
            >
              <Plus className="h-[22px] w-[22px]" strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p>{t("moduleAdd.trigger")}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="w-56 text-[13px]">
        <DropdownMenuLabel className="text-[13px]">
          {t("moduleAdd.title")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {modules.map((module) => {
          const Icon = module.icon;
          const preference = preferences[module.id];
          const onBar = preference.enabled && preference.position === "activityBar";
          return (
            <DropdownMenuCheckboxItem
              key={module.id}
              data-testid={`module-add-${module.id}`}
              checked={onBar}
              aria-label={t(onBar ? "moduleAdd.onBar" : "moduleAdd.offBar")}
              className="text-[13px]"
              // 保持面板打开，便于连续勾选多个模块。
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => toggle(module.id, onBar)}
            >
              <Icon aria-hidden="true" className="size-4" strokeWidth={1.6} />
              <span className="truncate">{t(module.titleKey as never)}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
