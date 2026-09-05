// 「更多」菜单底部的自定义区：勾选项常驻状态栏（从 StatusBar 拆出，行数棘轮约束）。
import { useStatusbarPrefsStore, type StatusbarItemId } from "@/stores/useStatusbarPrefsStore";

interface StatusbarCustomizeProps {
  items: Array<{ id: StatusbarItemId; label: string }>;
  title: string;
}

export default function StatusbarCustomize({ items, title }: StatusbarCustomizeProps) {
  const tucked = useStatusbarPrefsStore((s) => s.tuckedItems);
  const toggleTucked = useStatusbarPrefsStore((s) => s.toggleTucked);
  return (
    <div className="mt-1.5 border-t border-[var(--app-border)] pt-1.5">
      <p className="m-0 px-1.5 pb-1 text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
        {title}
      </p>
      {items.map((item) => (
        <label
          key={item.id}
          className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[length:var(--text-caption)] text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)]"
        >
          <input
            type="checkbox"
            checked={!tucked.includes(item.id)}
            onChange={() => toggleTucked(item.id)}
            className="h-3 w-3 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          {item.label}
        </label>
      ))}
    </div>
  );
}
