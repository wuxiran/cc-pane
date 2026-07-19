// Sidebar 显隐过渡 wrapper：grid 0fr↔1fr 动画（免测量、child 保持自身宽度只被裁剪），
// 过渡结束后卸载（已评审决议：保持 Sidebar 条件挂载的 watcher/焦点生命周期）。
// 终端尺寸适配依赖 TerminalView 现有 ResizeObserver 调度器，此处不派发 resize 事件。
import { useEffect, useRef, useState } from "react";

interface SidebarTransitionProps {
  visible: boolean;
  children: React.ReactNode;
}

export default function SidebarTransition({ visible, children }: SidebarTransitionProps) {
  const [mounted, setMounted] = useState(visible);
  const [expanded, setExpanded] = useState(visible);
  const rafRef = useRef(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // 先以 0fr 挂载，下一帧再展开，确保入场动画生效
      rafRef.current = requestAnimationFrame(() => setExpanded(true));
    } else {
      setExpanded(false);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [visible]);

  if (!mounted) return null;

  return (
    <div
      className="grid h-full shrink-0"
      style={{
        gridTemplateColumns: expanded ? "1fr" : "0fr",
        transition: "grid-template-columns var(--dur-slow) var(--ease-out)",
      }}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !visible) {
          setMounted(false);
        }
      }}
    >
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
