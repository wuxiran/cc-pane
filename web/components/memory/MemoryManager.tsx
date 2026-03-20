import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListPlus, Trash2, Search, Database, Save, X, Star, BrainCircuit, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMemoryStore } from "@/stores";
import type { MemoryScope, MemoryCategory, StoreMemoryRequest } from "@/types";

interface MemoryManagerProps {
  projectPath: string;
}

function ImportanceStars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={14}
          className={`${n <= value ? "text-amber-400 fill-amber-400" : "text-muted-foreground/30"} ${
            onChange ? "cursor-pointer hover:text-amber-300" : ""
          }`}
          onClick={() => onChange?.(n)}
        />
      ))}
    </div>
  );
}

export default function MemoryManager({ projectPath }: MemoryManagerProps) {
  const { t } = useTranslation("dialogs");
  const { t: tNotify } = useTranslation("notifications");

  const SCOPE_LABELS: Record<MemoryScope, string> = {
    global: t("memoryGlobal"),
    workspace: t("memoryWorkspace"),
    project: t("memoryProject"),
    session: t("memorySession"),
  };

  const CATEGORY_OPTIONS: { value: MemoryCategory; label: string }[] = [
    { value: "decision", label: t("categoryDecision") },
    { value: "lesson", label: t("categoryExperience") },
    { value: "preference", label: t("categoryPreference") },
    { value: "pattern", label: t("categoryPattern") },
    { value: "fact", label: t("categoryFact") },
    { value: "plan", label: t("categoryPlan") },
  ];

  const memories = useMemoryStore((s) => s.memories);
  const total = useMemoryStore((s) => s.total);
  const loading = useMemoryStore((s) => s.loading);
  const selectedMemory = useMemoryStore((s) => s.selectedMemory);
  const searchText = useMemoryStore((s) => s.searchText);
  const selectedScope = useMemoryStore((s) => s.selectedScope);
  const search = useMemoryStore((s) => s.search);
  const loadList = useMemoryStore((s) => s.loadList);
  const store = useMemoryStore((s) => s.store);
  const update = useMemoryStore((s) => s.update);
  const remove = useMemoryStore((s) => s.remove);
  const select = useMemoryStore((s) => s.select);
  const setSearchText = useMemoryStore((s) => s.setSearchText);
  const setSelectedScope = useMemoryStore((s) => s.setSelectedScope);
  const reset = useMemoryStore((s) => s.reset);

  const [isCreating, setIsCreating] = useState(false);
  const [editForm, setEditForm] = useState({
    title: "",
    content: "",
    category: "fact" as MemoryCategory,
    importance: 3,
    tags: "",
  });

  // 初始化加载
  useEffect(() => {
    loadList({ projectPath });
    return () => reset();
  }, [projectPath, loadList, reset]);

  // 搜索去抖
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchText.trim()) {
        search({ search: searchText, project_path: projectPath, scope: selectedScope ?? undefined });
      } else {
        loadList({ projectPath, scope: selectedScope ?? undefined });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, selectedScope, projectPath, search, loadList]);

  // 选中时填充编辑表单
  useEffect(() => {
    if (selectedMemory) {
      setEditForm({
        title: selectedMemory.title,
        content: selectedMemory.content,
        category: selectedMemory.category as MemoryCategory,
        importance: selectedMemory.importance,
        tags: selectedMemory.tags.join(", "),
      });
      setIsCreating(false);
    }
  }, [selectedMemory]);

  const handleNew = useCallback(() => {
    select(null);
    setIsCreating(true);
    setEditForm({ title: "", content: "", category: "fact", importance: 3, tags: "" });
  }, [select]);

  const handleSave = useCallback(async () => {
    if (!editForm.title.trim()) {
      toast.error(tNotify("titleRequired"));
      return;
    }
    const tags = editForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (isCreating) {
        const request: StoreMemoryRequest = {
          title: editForm.title.trim(),
          content: editForm.content,
          scope: "project",
          category: editForm.category,
          importance: editForm.importance,
          project_path: projectPath,
          tags,
          source: "user",
        };
        await store(request);
        setIsCreating(false);
        toast.success(tNotify("memoryCreated"));
      } else if (selectedMemory) {
        await update(selectedMemory.id, {
          title: editForm.title.trim(),
          content: editForm.content,
          category: editForm.category,
          importance: editForm.importance,
          tags,
        });
        toast.success(tNotify("memoryUpdated"));
      }
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  }, [editForm, isCreating, selectedMemory, projectPath, store, update]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await remove(id);
        toast.success(tNotify("memoryDeleted"));
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [remove]
  );

  const handleCancel = useCallback(() => {
    setIsCreating(false);
    select(null);
  }, [select]);

  const showEditor = isCreating || selectedMemory;

  return (
    <div className="flex h-full">
      {/* 左侧列表 */}
      <div className="w-72 flex-shrink-0 border-r border-border flex flex-col">
        {/* 搜索栏 */}
        <div className="px-3 py-2.5 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database size={16} className="text-muted-foreground" />
              <span className="text-sm font-medium">Memory</span>
              <Badge variant="secondary" className="text-xs">
                {total}
              </Badge>
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleNew}>
              <ListPlus size={14} />
            </Button>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t("search", { ns: "common" })}
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

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("loading", { ns: "common" })}</span>
            </div>
          )}

          {!loading && memories.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <BrainCircuit size={28} className="mx-auto mb-3 opacity-40" />
              <p className="text-xs">{t("noMemory")}</p>
              <p className="text-xs mt-1">{t("clickToCreate")}</p>
            </div>
          )}

          {memories.map((memory) => (
            <div
              key={memory.id}
              className={`group flex items-start gap-2 px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors ${
                selectedMemory?.id === memory.id ? "bg-accent" : ""
              }`}
              onClick={() => select(memory)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">{memory.title}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <ImportanceStars value={memory.importance} />
                  <Badge variant="outline" className="text-[10px] h-4">
                    {CATEGORY_OPTIONS.find((c) => c.value === memory.category)?.label ?? memory.category}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {memory.content.slice(0, 80)}
                </p>
              </div>
              <div className="hidden group-hover:flex items-center gap-1 pt-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(memory.id);
                  }}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧编辑器 */}
      <div className="flex-1 overflow-hidden">
        {showEditor ? (
          <MemoryEditor
            form={editForm}
            isNew={isCreating}
            onChange={setEditForm}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <BrainCircuit size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("selectOrCreateMemory")}</p>
              <p className="text-xs mt-1 text-muted-foreground/60">
                {t("memoryDesc")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 内联编辑器 ============

interface MemoryEditorProps {
  form: {
    title: string;
    content: string;
    category: MemoryCategory;
    importance: number;
    tags: string;
  };
  isNew: boolean;
  onChange: (form: MemoryEditorProps["form"]) => void;
  onSave: () => void;
  onCancel: () => void;
}

function MemoryEditor({ form, isNew, onChange, onSave, onCancel }: MemoryEditorProps) {
  const { t } = useTranslation("dialogs");

  const CATEGORY_OPTIONS: { value: MemoryCategory; label: string }[] = [
    { value: "decision", label: t("categoryDecision") },
    { value: "lesson", label: t("categoryExperience") },
    { value: "preference", label: t("categoryPreference") },
    { value: "pattern", label: t("categoryPattern") },
    { value: "fact", label: t("categoryFact") },
    { value: "plan", label: t("categoryPlan") },
  ];

  // Ctrl+S 保存
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [onSave]);

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border">
        <div className="flex-1">
          <Input
            value={form.title}
            onChange={(e) => onChange({ ...form, title: e.target.value })}
            placeholder={t("memoryTitlePlaceholder")}
            className="h-8 text-sm font-medium"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X size={14} className="mr-1" /> {t("cancel", { ns: "common" })}
          </Button>
          <Button size="sm" onClick={onSave} disabled={!form.title.trim()}>
            <Save size={14} className="mr-1" /> {isNew ? t("create", { ns: "common" }) : t("save", { ns: "common" })}
          </Button>
        </div>
      </div>

      {/* 属性栏 */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">{t("memoryCategory")}</Label>
          <select
            value={form.category}
            onChange={(e) => onChange({ ...form, category: e.target.value as MemoryCategory })}
            className="h-7 px-2 text-xs rounded-md border border-input bg-background"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">{t("memoryImportance")}</Label>
          <ImportanceStars
            value={form.importance}
            onChange={(v) => onChange({ ...form, importance: v })}
          />
        </div>
        <div className="flex items-center gap-2 flex-1">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("memoryTags")}</Label>
          <Input
            value={form.tags}
            onChange={(e) => onChange({ ...form, tags: e.target.value })}
            placeholder={t("memoryTagsPlaceholder")}
            className="h-7 text-xs"
          />
        </div>
      </div>

      {/* 内容编辑区 */}
      <div className="flex-1 overflow-hidden">
        <textarea
          value={form.content}
          onChange={(e) => onChange({ ...form, content: e.target.value })}
          className="w-full h-full p-4 text-sm font-mono bg-background resize-none focus:outline-none border-none"
          placeholder={t("memoryContentPlaceholder")}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
