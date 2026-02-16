import { Trash2, Terminal } from "lucide-react";
import { useThemeStore } from "@/stores";
import { formatRelativeTime } from "@/utils";
import type { LaunchRecord } from "@/services";

interface RecentLaunchesProps {
  launchHistory: LaunchRecord[];
  onOpenTerminal: (path: string) => void;
  onClearHistory: () => void;
}

export default function RecentLaunches({ launchHistory, onOpenTerminal, onClearHistory }: RecentLaunchesProps) {
  const isDark = useThemeStore((s) => s.isDark);

  if (launchHistory.length === 0) return null;

  return (
    <>
      <div className="flex items-center justify-between px-3 py-3 mt-4 mb-1">
        <span className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>最近启动</span>
        <button
          className={`transition-colors p-1 rounded-md ${isDark ? 'text-slate-500 hover:bg-white/10 hover:text-slate-300' : 'text-slate-400 hover:bg-white/50 hover:text-red-500'}`}
          onClick={onClearHistory}
          title="清空历史"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {launchHistory.map((record) => (
        <button
          key={record.id}
          className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 border border-transparent ${
            isDark
              ? 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              : 'text-slate-500 hover:bg-white/40 hover:text-slate-900 hover:shadow-sm'
          }`}
          onClick={() => onOpenTerminal(record.project_path)}
        >
          <div className="flex items-center gap-3">
            <Terminal className="w-4 h-4 text-slate-400 group-hover:text-slate-500" />
            <span className="text-sm font-medium tracking-wide truncate max-w-[140px]">{record.project_name}</span>
          </div>
          <span className={`text-[10px] shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            {formatRelativeTime(record.launched_at)}
          </span>
        </button>
      ))}
    </>
  );
}
