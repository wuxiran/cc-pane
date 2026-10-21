import type { TaskBinding } from "@/types";
import OrchestratorTaskCard from "@/components/sidebar/OrchestratorTaskCard";
type TaskListProps = {
  bindings: TaskBinding[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
};
export default function OrchestrationTaskList({ bindings, selectedTaskId, onSelect }: TaskListProps) {
  return (
    <div className="space-y-1">
      {bindings.map((binding) => {
        const selected = binding.id === selectedTaskId;
        return (
          <div
            key={binding.id}
            role="button"
            tabIndex={0}
            className="relative block w-full rounded-lg text-left transition-colors duration-[var(--dur-fast)]"
            style={{
              background: selected ? "var(--app-active-bg)" : "transparent",
            }}
            onClick={() => onSelect(binding.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(binding.id);
              }
            }}
          >
            {/* demo 式选中态：左缘 accent 竖条 + active-bg 弱底 */}
            {selected && (
              <span
                aria-hidden
                className="absolute left-0 top-1.5 bottom-1.5 z-10 w-[3px] rounded-full"
                style={{ background: "var(--app-accent)" }}
              />
            )}
            {/* fix(M3) review: 外层不再使用 button，避免 TaskCard 内部操作按钮嵌套。 */}
            <OrchestratorTaskCard binding={binding} />
          </div>
        );
      })}
    </div>
  );
}
