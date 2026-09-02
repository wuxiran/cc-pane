// ACP Session Config Options（`configOptions`）→ composer 底栏选择器。
//
// 协议里 mode / model / thought_level / model_config 都走这一张表；老适配器另外还发
// `modes` / `models` 两个兼容字段。去重规则：**legacy 选择器已经在渲染的类别这里不再
// 重复**（`hiddenCategories`），其余类别（思维深度等）以及 legacy 缺席时的 mode/model
// 都从这里出。只有 `select` 类型可渲染；其他类型原样忽略，等协议长出对应控件再接。
import { Brain, Cpu, Gauge, SlidersHorizontal, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AcpConfigOption } from "@/types/agentChat";
import { HeaderSelect } from "./ChatItems";

const CATEGORY_ICON: Record<string, ReactNode> = {
  mode: <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 opacity-70" />,
  model: <Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />,
  thought_level: <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />,
  model_config: <Gauge className="h-3.5 w-3.5 shrink-0 opacity-70" />,
};

/** 可渲染的 select 项：有 configId、有至少一个 option。 */
export function selectableConfigOptions(
  options: AcpConfigOption[] | undefined,
  hiddenCategories: ReadonlySet<string>,
): AcpConfigOption[] {
  return (options ?? []).filter(
    (option) =>
      typeof option.configId === "string"
      && option.configId
      && (option.type ?? "select") === "select"
      && Array.isArray(option.options)
      && option.options.length > 0
      && !(option.category && hiddenCategories.has(option.category)),
  );
}

interface ConfigOptionSelectorsProps {
  options: AcpConfigOption[] | undefined;
  /** legacy `models` / `modes` 选择器已占用的类别，避免同一个开关出现两次。 */
  hiddenCategories: ReadonlySet<string>;
  onSelect: (option: AcpConfigOption, value: string) => void;
}

export default function ConfigOptionSelectors({ options, hiddenCategories, onSelect }: ConfigOptionSelectorsProps) {
  const { t } = useTranslation("panes");
  const visible = selectableConfigOptions(options, hiddenCategories);
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((option) => {
        const current = option.currentValue;
        const currentId = typeof current === "string" ? current : current == null ? undefined : String(current);
        const items = (option.options ?? []).map((choice) => ({
          id: choice.value,
          label: choice.name || choice.value,
          description: choice.description,
        }));
        const icon = CATEGORY_ICON[option.category ?? ""] ?? (
          <Settings2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
        );
        const label =
          option.category === "thought_level"
            ? t("agentChatThoughtLevel")
            : option.name || option.configId;
        return (
          <span key={option.configId} title={option.description ? `${label} · ${option.description}` : label}>
            <HeaderSelect
              icon={icon}
              items={items}
              currentId={currentId}
              onSelect={(value) => onSelect(option, value)}
            />
          </span>
        );
      })}
    </>
  );
}
