// 侧栏显隐容器：直接挂载/卸载，不做宽度动画。宽度动画期间 TerminalView 的
// ResizeObserver 会连续 refit 所有可见终端，代价高且手感拖沓（docs/46 §5）。
// 组件保留为单一落点，保持 Sidebar 条件挂载的 watcher/焦点生命周期。
interface SidebarTransitionProps {
  visible: boolean;
  children: React.ReactNode;
}

export default function SidebarTransition({ visible, children }: SidebarTransitionProps) {
  if (!visible) return null;
  return (
    <div className="h-full shrink-0">
      <div className="h-full min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
