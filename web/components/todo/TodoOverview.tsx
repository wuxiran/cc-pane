import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ListTodo,
  Clock,
  PlayCircle,
  CheckCircle2,
  AlertTriangle,
  Flag,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTodoStore } from "@/stores";
import type { TodoItem } from "@/types";

interface TodoOverviewProps {
  todos: TodoItem[];
  onSelectTodo: (todo: TodoItem) => void;
  onCreateNew: () => void;
}

/** 统计卡片 */
function StatCard({
  icon,
  label,
  count,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/30 bg-card shadow-sm p-4 hover:shadow-md hover:-translate-y-[1px] transition-all">
      <div className={`shrink-0 w-9 h-9 rounded-full bg-muted/50 border border-border/30 flex items-center justify-center ${color}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-none">{count}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
      </div>
    </div>
  );
}

/** 优先级进度条 */
function PriorityBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-8 text-right">
        {label}
      </span>
      <div className="flex-1 h-2 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-6">{count}</span>
    </div>
  );
}

export default function TodoOverview({
  todos,
  onSelectTodo,
  onCreateNew,
}: TodoOverviewProps) {
  const { t } = useTranslation("dialogs");
  const stats = useTodoStore((s) => s.stats);
  const loadStats = useTodoStore((s) => s.loadStats);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const total = stats?.total ?? todos.length;
  const todoCount = stats?.byStatus?.todo ?? 0;
  const inProgressCount = stats?.byStatus?.in_progress ?? 0;
  const doneCount = stats?.byStatus?.done ?? 0;
  const overdueCount = stats?.overdue ?? 0;

  const highCount = stats?.byPriority?.high ?? 0;
  const mediumCount = stats?.byPriority?.medium ?? 0;
  const lowCount = stats?.byPriority?.low ?? 0;

  // 最近更新的 5 条
  const recentTodos = [...todos]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 5);

  return (
    <div className="flex flex-col items-center justify-center h-full px-8 py-6 max-w-xl mx-auto">
      <h3 className="text-sm font-semibold mb-4">{t("todoOverviewTitle")}</h3>

      {/* 数字卡片 */}
      <div className="grid grid-cols-3 gap-2.5 w-full mb-5">
        <StatCard
          icon={<ListTodo size={18} />}
          label={t("todoOverviewTotal")}
          count={total}
          color="text-foreground"
        />
        <StatCard
          icon={<Clock size={18} />}
          label={t("todoTodo")}
          count={todoCount}
          color="text-muted-foreground"
        />
        <StatCard
          icon={<PlayCircle size={18} />}
          label={t("todoInProgress")}
          count={inProgressCount}
          color="text-blue-500"
        />
        <StatCard
          icon={<CheckCircle2 size={18} />}
          label={t("todoDone")}
          count={doneCount}
          color="text-emerald-500"
        />
        <StatCard
          icon={<AlertTriangle size={18} />}
          label={t("todoOverviewOverdue")}
          count={overdueCount}
          color="text-red-500"
        />
      </div>

      {/* 优先级分布 */}
      <div className="w-full mb-5">
        <div className="flex items-center gap-1.5 mb-2">
          <Flag size={12} className="text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            {t("todoOverviewPriority")}
          </span>
        </div>
        <div className="space-y-1.5">
          <PriorityBar
            label={t("todoPriorityHigh")}
            count={highCount}
            total={total}
            color="bg-rose-500"
          />
          <PriorityBar
            label={t("todoPriorityMedium")}
            count={mediumCount}
            total={total}
            color="bg-amber-500"
          />
          <PriorityBar
            label={t("todoPriorityLow")}
            count={lowCount}
            total={total}
            color="bg-slate-400"
          />
        </div>
      </div>

      {/* 最近更新 */}
      {recentTodos.length > 0 && (
        <div className="w-full mb-4">
          <span className="text-xs font-medium text-muted-foreground mb-2 block">
            {t("todoOverviewRecent")}
          </span>
          <div className="space-y-1">
            {recentTodos.map((todo) => (
              <button
                key={todo.id}
                onClick={() => onSelectTodo(todo)}
                className="w-full text-left px-2.5 py-1.5 text-xs rounded-xl border border-transparent hover:bg-accent/50 hover:shadow-sm transition-all truncate text-foreground/80"
              >
                {todo.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 快速创建 */}
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 w-full"
        onClick={onCreateNew}
      >
        <Plus size={14} />
        {t("todoNewTask")}
      </Button>
    </div>
  );
}
