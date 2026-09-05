// 配置作用域徽标：标注当前配置是「全局共享 / 工作空间 / 启动配置」哪一层，
// 并提供跨层跳转。多入口配置（MCP/技能/Provider）改了不生效的最大来源就是
// 用户分不清自己在哪一层（批 5 配置收敛）。
import { Globe2, Layers, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingsPaneId } from "./settingsRegistry";
import { navigateToSettings } from "./settingsNavigation";

export type SettingsScope = "global" | "workspace" | "profile";

interface ScopeBannerProps {
  scope: SettingsScope;
  /** settings 命名空间的说明文案 key */
  descriptionKey: string;
  /** 可选跨层跳转（如工作空间页 → 全局页） */
  link?: { labelKey: string; paneId: SettingsPaneId };
}

const SCOPE_META: Record<SettingsScope, { icon: typeof Globe2; labelKey: string }> = {
  global: { icon: Globe2, labelKey: "scope.global" },
  workspace: { icon: Layers, labelKey: "scope.workspace" },
  profile: { icon: Package, labelKey: "scope.profile" },
};

export default function ScopeBanner({ scope, descriptionKey, link }: ScopeBannerProps) {
  const { t } = useTranslation("settings");
  const Icon = SCOPE_META[scope].icon;
  return (
    <div
      data-testid={`scope-banner-${scope}`}
      className="flex items-start gap-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] px-3 py-2.5"
    >
      <span
        className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] px-2 py-0.5 text-[11px] font-medium"
        style={{ color: "var(--app-accent)" }}
      >
        <Icon size={12} />
        {t(SCOPE_META[scope].labelKey as never)}
      </span>
      <p className="m-0 min-w-0 flex-1 text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>
        {t(descriptionKey as never)}
        {link ? (
          <>
            {" "}
            <button
              type="button"
              className="underline cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              style={{ color: "var(--app-accent)" }}
              onClick={() => navigateToSettings({ paneId: link.paneId })}
            >
              {t(link.labelKey as never)}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}
