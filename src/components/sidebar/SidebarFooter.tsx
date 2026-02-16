import { Pin, Minimize2, PanelTopDashed, Settings } from "lucide-react";
import { useThemeStore, useMiniModeStore, useBorderlessStore } from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";

interface SidebarFooterProps {
  collapsed: boolean;
  onSettings: () => void;
}

export default function SidebarFooter({ collapsed, onSettings }: SidebarFooterProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const enterMiniMode = useMiniModeStore((s) => s.enterMiniMode);
  const toggleBorderless = useBorderlessStore((s) => s.toggleBorderless);
  const { isPinned, togglePin } = useWindowControl();

  if (collapsed) {
    return (
      <div className="mt-auto flex flex-col items-center gap-2 pb-4">
        <Settings
          className={`w-4 h-4 cursor-pointer transition-all hover:rotate-90 ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-400 hover:text-slate-600'}`}
          onClick={onSettings}
        />
      </div>
    );
  }

  return (
    <div className={`p-4 border-t backdrop-blur-xl ${isDark ? 'border-white/10' : 'border-white/40'}`}>
      <div className={`flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors backdrop-blur-md ${
        isDark
          ? 'bg-black/20 hover:bg-black/30 border border-white/5'
          : 'bg-white/40 hover:bg-white/60 border border-white/40 shadow-sm'
      }`}>
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
            <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-500 blur-sm"></div>
          </div>
          <span className={`text-xs font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>System Ready</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`p-1 rounded-md transition-all ${isPinned ? 'text-[var(--app-accent)]' : ''} ${isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-400 hover:bg-white/60 hover:text-slate-600'}`}
            onClick={togglePin}
            title="窗口置顶"
          >
            <Pin className={`w-3.5 h-3.5 ${isPinned ? 'rotate-45' : ''} transition-transform`} />
          </button>
          <button
            className={`p-1 rounded-md transition-all ${isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-400 hover:bg-white/60 hover:text-slate-600'}`}
            onClick={() => enterMiniMode()}
            title="迷你模式"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            className={`p-1 rounded-md transition-all ${isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200' : 'text-slate-400 hover:bg-white/60 hover:text-slate-600'}`}
            onClick={() => toggleBorderless()}
            title="无边框模式"
          >
            <PanelTopDashed className="w-3.5 h-3.5" />
          </button>
          <Settings
            className={`w-4 h-4 cursor-pointer transition-all hover:rotate-90 ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-400 hover:text-slate-600'}`}
            onClick={onSettings}
          />
        </div>
      </div>
    </div>
  );
}
