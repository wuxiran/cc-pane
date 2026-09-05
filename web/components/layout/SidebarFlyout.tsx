// 窄档侧栏浮出层：覆盖在主区上方的绝对定位层，不挤占主内容宽度。
// 结构 = 全层 scrim（点击关闭）+ 左侧飞出的侧栏内容。scrim 用 bg-black/40
// （与 ui/sheet 的 bg-black/50 同一中性遮罩惯例，不新增 token）。
// 入场：面板 slide-in-from-left + scrim fade，--dur-slow + --ease-out；
// 只作入场（open=false 即卸载，无离场架构）。prefers-reduced-motion 由
// index.css 的全局规则兜底（keyframe 时长归零，直接呈现终态）。
import { useTranslation } from "react-i18next";
import { SIDEBAR_FLYOUT_MAX_VW } from "@/lib/sidebarFlyout";

interface SidebarFlyoutProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export default function SidebarFlyout({ open, onClose, children }: SidebarFlyoutProps) {
  const { t } = useTranslation("sidebar");
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-20" data-testid="sidebar-flyout">
      <button
        type="button"
        data-testid="sidebar-flyout-scrim"
        aria-label={t("collapseSidebar")}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40 animate-in fade-in duration-[var(--dur-slow)] ease-[var(--ease-out)]"
        onClick={onClose}
      />
      <div
        className="absolute inset-y-0 left-0 overflow-hidden animate-in slide-in-from-left fade-in duration-[var(--dur-slow)] ease-[var(--ease-out)]"
        style={{ maxWidth: `${SIDEBAR_FLYOUT_MAX_VW}vw` }}
      >
        {children}
      </div>
    </div>
  );
}
