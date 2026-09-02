// 设置 → 实验性功能：每个开关对应 ExperimentalSettings 的一个字段。默认全关，
// 用户勾选后相关入口（活动栏图标 / 全屏页 / 面板区块）才渲染。
import { FlaskConical, ImagePlus, Store } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ExperimentalFeatureId, ExperimentalSettings } from "@/types";

interface ExperimentalSectionProps {
  value: ExperimentalSettings;
  onChange: (value: ExperimentalSettings) => void;
}

const FEATURES: {
  id: ExperimentalFeatureId;
  icon: typeof ImagePlus;
  labelKey: "experimental.mediaGeneration" | "experimental.skillMarket";
  descKey: "experimental.mediaGenerationDesc" | "experimental.skillMarketDesc";
}[] = [
  {
    id: "mediaGeneration",
    icon: ImagePlus,
    labelKey: "experimental.mediaGeneration",
    descKey: "experimental.mediaGenerationDesc",
  },
  {
    id: "skillMarket",
    icon: Store,
    labelKey: "experimental.skillMarket",
    descKey: "experimental.skillMarketDesc",
  },
];

export default function ExperimentalSection({ value, onChange }: ExperimentalSectionProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3 rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-4 py-3">
        <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--app-status-warning)]" />
        <p className="m-0 text-[12px] leading-relaxed text-[var(--app-text-secondary)]">
          {t("experimental.notice")}
        </p>
      </div>
      <div className="flex flex-col divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-sm">
        {FEATURES.map(({ id, icon: Icon, labelKey, descKey }) => {
          const switchId = `experimental-${id}`;
          return (
            <div key={id} className="flex items-center gap-4 px-5 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active-bg)] text-[var(--app-accent)]">
                <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.6} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Label htmlFor={switchId} className="text-[13px] text-[var(--app-text-primary)]">
                  {t(labelKey)}
                </Label>
                <p className="m-0 text-[12px] text-[var(--app-text-tertiary)]">{t(descKey)}</p>
              </div>
              <Switch
                id={switchId}
                checked={value[id]}
                onCheckedChange={(checked) => onChange({ ...value, [id]: checked === true })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
