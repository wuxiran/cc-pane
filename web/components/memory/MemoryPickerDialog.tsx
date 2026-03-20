import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Star, Brain } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { memoryService } from "@/services";
import type { Memory, MemoryScope } from "@/types";

interface MemoryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onConfirm: (memoryIds: string[]) => void;
}

export default function MemoryPickerDialog({
  open,
  onOpenChange,
  projectPath,
  onConfirm,
}: MemoryPickerDialogProps) {
  const { t } = useTranslation("dialogs");

  const SCOPE_LABELS: Record<MemoryScope, string> = useMemo(() => ({
    global: t("memoryGlobal"),
    workspace: t("memoryWorkspace"),
    project: t("memoryProject"),
    session: t("memorySession"),
  }), [t]);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [selectedScope, setSelectedScope] = useState<MemoryScope | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 加载
  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const result = searchText.trim()
        ? await memoryService.search({
            search: searchText,
            project_path: projectPath,
            scope: selectedScope ?? undefined,
            limit: 50,
          })
        : await memoryService.list({
            projectPath,
            scope: selectedScope ?? undefined,
            limit: 50,
          });
      setMemories(result.items);
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, [searchText, selectedScope, projectPath]);

  // 打开时重置并加载
  useEffect(() => {
    if (open) {
      setSearchText("");
      setSelectedScope(null);
      setSelectedIds(new Set());
      loadMemories();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索去抖
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(loadMemories, 300);
    return () => clearTimeout(timer);
  }, [searchText, selectedScope, loadMemories, open]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(Array.from(selectedIds));
    onOpenChange(false);
  }, [selectedIds, onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain size={18} />
            {t("memoryPickerTitle")}
          </DialogTitle>
        </DialogHeader>

        {/* 搜索 + 筛选 */}
        <div className="space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t("memoryPickerSearch")}
              className="h-8 text-sm pl-8"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            <Badge
              variant={selectedScope === null ? "default" : "outline"}
              className="cursor-pointer text-xs"
              onClick={() => setSelectedScope(null)}
            >
              {t("memoryAll")}
            </Badge>
            {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map((scope) => (
              <Badge
                key={scope}
                variant={selectedScope === scope ? "default" : "outline"}
                className="cursor-pointer text-xs"
                onClick={() => setSelectedScope(scope)}
              >
                {SCOPE_LABELS[scope]}
              </Badge>
            ))}
          </div>
        </div>

        {/* Memory 列表 */}
        <div className="flex-1 overflow-y-auto border rounded-md min-h-[200px] max-h-[400px]">
          {loading && (
            <p className="text-sm text-muted-foreground text-center py-8">{t("loading", { ns: "common" })}</p>
          )}

          {!loading && memories.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("memoryPickerNoMemory")}
            </p>
          )}

          {memories.map((memory) => (
            <label
              key={memory.id}
              className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors border-b border-border/50 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(memory.id)}
                onChange={() => toggleSelect(memory.id)}
                className="mt-0.5 rounded border-input"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{memory.title}</span>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {Array.from({ length: memory.importance }, (_, i) => (
                      <Star key={i} size={10} className="text-amber-400 fill-amber-400" />
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {memory.content.slice(0, 100)}
                </p>
              </div>
            </label>
          ))}
        </div>

        <DialogFooter>
          <span className="text-xs text-muted-foreground mr-auto">
            {t("memoryPickerSelected", { count: selectedIds.size })}
          </span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={selectedIds.size === 0}>
            {t("confirm", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
