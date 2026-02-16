import { Command, X, Minimize2, Maximize2, UploadCloud, FolderPlus } from "lucide-react";
import { useThemeStore } from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";

interface WindowControlsProps {
  collapsed: boolean;
  onImport: () => void;
  onNew: () => void;
}

export default function WindowControls({ collapsed, onImport, onNew }: WindowControlsProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const { closeWindow, minimizeWindow, maximizeWindow, startDrag } = useWindowControl();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pt-5 pb-3">
        <button className="w-2.5 h-2.5 rounded-full bg-[#FF5F57] cursor-pointer" onClick={closeWindow} />
        <button className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E] cursor-pointer" onClick={minimizeWindow} />
        <button className="w-2.5 h-2.5 rounded-full bg-[#28C840] cursor-pointer" onClick={maximizeWindow} />
      </div>
    );
  }

  return (
    <div className="p-4 pt-5">
      {/* Mac 红绿灯 */}
      <div
        className="flex items-center gap-2 mb-6 px-1 group"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) { e.preventDefault(); startDrag(); }
        }}
      >
        <button
          className="w-3 h-3 rounded-full bg-[#FF5F57] border border-[#E0443E] shadow-sm flex items-center justify-center cursor-pointer"
          onClick={closeWindow}
        >
          <X className="w-2 h-2 text-[#4e0002] opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          className="w-3 h-3 rounded-full bg-[#FEBC2E] border border-[#D89E24] shadow-sm flex items-center justify-center cursor-pointer"
          onClick={minimizeWindow}
        >
          <Minimize2 className="w-2 h-2 text-[#5a3e00] opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          className="w-3 h-3 rounded-full bg-[#28C840] border border-[#1AAB29] shadow-sm flex items-center justify-center cursor-pointer"
          onClick={maximizeWindow}
        >
          <Maximize2 className="w-2 h-2 text-[#004d0f] opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <div
          className="flex-1 h-3 cursor-grab"
          onMouseDown={(e) => { e.preventDefault(); startDrag(); }}
        />
      </div>

      {/* 品牌区 */}
      <div className="flex items-center gap-3 mb-6 px-1">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-lg backdrop-blur-md border transition-transform hover:scale-105 ${
          isDark
            ? 'bg-gradient-to-br from-blue-600/80 to-indigo-600/80 shadow-blue-500/20 border-white/10'
            : 'bg-gradient-to-br from-white/80 to-white/40 shadow-blue-200/50 border-white/60'
        }`}>
          <Command className={`w-5 h-5 ${isDark ? 'text-white' : 'text-blue-600'}`} />
        </div>
        <div>
          <h1 className={`font-bold text-lg tracking-tight leading-none ${isDark ? 'text-white drop-shadow-md' : 'text-slate-800'}`}>CC-Panes</h1>
          <span className={`text-[10px] font-medium tracking-wider uppercase opacity-60 ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>Dev Dashboard</span>
        </div>
      </div>

      {/* 导入/新建 按钮网格 */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <button
          className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all shadow-lg active:scale-95 border border-transparent ${
            isDark
              ? 'bg-blue-600/80 hover:bg-blue-500/90 text-white shadow-blue-900/20 backdrop-blur-sm border-white/10'
              : 'bg-blue-500 hover:bg-blue-600 text-white shadow-blue-500/30'
          }`}
          onClick={onImport}
        >
          <UploadCloud className="w-4 h-4" />
          <span>导入项目</span>
        </button>
        <button
          className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all border active:scale-95 backdrop-blur-sm ${
            isDark
              ? 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-200 hover:border-white/20'
              : 'bg-white/40 border-white/60 hover:bg-white/70 text-slate-700 shadow-sm'
          }`}
          onClick={onNew}
        >
          <FolderPlus className="w-4 h-4" />
          <span>新建项目</span>
        </button>
      </div>
    </div>
  );
}
