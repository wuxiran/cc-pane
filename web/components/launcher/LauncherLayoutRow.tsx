// 目标布局：默认「自动」= findLayoutForWorkspace 按工作空间绑定推导；可显式指定布局。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePanesStore } from "@/stores";
import { findLayoutForWorkspace } from "@/utils/layoutWorkspace";

interface LauncherLayoutRowProps {
  value?: string;
  onChange: (layoutId: string | undefined) => void;
  /** 自动推导用：当前草稿解析出的工作空间名 */
  workspaceName?: string;
}

export default function LauncherLayoutRow({ value, onChange, workspaceName }: LauncherLayoutRowProps) {
  const { t } = useTranslation("launcher");
  // 不能写成 usePanesStore((s) => s.listLayouts())：listLayouts 内部是 filter().map()，
  // 每次调用都返回新数组，useSyncExternalStore 的快照永不相等 → 无限重渲染直接崩页。
  // 故只选稳定引用，再在本地复现它的投影语义：当前布局要换上实时 rootPane，
  // 因为 findLayoutForWorkspace 依赖 rootPane 里的 tab 推导 derived 绑定。
  const layoutEntries = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const rootPane = usePanesStore((s) => s.rootPane);
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const layouts = useMemo(
    () => layoutEntries
      .filter((layout) => layout.kind !== "starred")
      .map((layout) => (
        layout.id === currentLayoutId
          ? { ...layout, rootPane, activePaneId }
          : layout
      )),
    [layoutEntries, currentLayoutId, rootPane, activePaneId],
  );
  const autoHit = workspaceName ? findLayoutForWorkspace(layouts, workspaceName) : null;

  return (
    <div className="flex items-center gap-2">
      <select
        className="h-8 min-w-[160px] rounded-md border bg-background px-2 text-xs"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        aria-label={t("targetLayout")}
      >
        <option value="">
          {autoHit ? t("layoutAutoHit", { name: autoHit.name }) : t("layoutAuto")}
        </option>
        {layouts.map((layout) => (
          <option key={layout.id} value={layout.id}>
            {layout.name}
          </option>
        ))}
      </select>
    </div>
  );
}
