import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, CodeXml, Wand2, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSkillStore } from "@/stores";
import SkillEditor from "./SkillEditor";

interface SkillManagerProps {
  projectPath: string;
}

export default function SkillManager({ projectPath }: SkillManagerProps) {
  const { t } = useTranslation("dialogs");
  const { t: tNotify } = useTranslation("notifications");

  const skills = useSkillStore((s) => s.skills);
  const activeSkill = useSkillStore((s) => s.activeSkill);
  const loading = useSkillStore((s) => s.loading);
  const loadSkills = useSkillStore((s) => s.loadSkills);
  const selectSkill = useSkillStore((s) => s.selectSkill);
  const saveSkill = useSkillStore((s) => s.saveSkill);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);
  const clearActiveSkill = useSkillStore((s) => s.clearActiveSkill);

  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadSkills(projectPath);
    return () => clearActiveSkill();
  }, [projectPath, loadSkills, clearActiveSkill]);

  const handleSelect = useCallback(
    (name: string) => {
      setIsCreating(false);
      selectSkill(projectPath, name);
    },
    [projectPath, selectSkill]
  );

  const handleNew = useCallback(() => {
    clearActiveSkill();
    setIsCreating(true);
  }, [clearActiveSkill]);

  const handleSave = useCallback(
    async (name: string, content: string) => {
      try {
        await saveSkill(projectPath, name, content);
        setIsCreating(false);
        toast.success(tNotify("skillSaved"));
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [projectPath, saveSkill]
  );

  const handleDelete = useCallback(
    async (name: string) => {
      try {
        await deleteSkill(projectPath, name);
        toast.success(tNotify("skillDeleted"));
      } catch (e) {
        toast.error(tNotify("operationFailed", { error: String(e) }));
      }
    },
    [projectPath, deleteSkill]
  );

  const handleCancel = useCallback(() => {
    setIsCreating(false);
    clearActiveSkill();
  }, [clearActiveSkill]);

  const showEditor = isCreating || activeSkill;

  return (
    <div className="flex h-full">
      {/* 左侧列表 */}
      <div className="w-64 flex-shrink-0 border-r border-border flex flex-col">
        {/* 列表标题 */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Wand2 size={16} className="text-muted-foreground" />
            <span className="text-sm font-medium">{t("skillTitle")}</span>
            <Badge variant="secondary" className="text-xs">
              {skills.length}
            </Badge>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleNew}>
            <Plus size={14} />
          </Button>
        </div>

        {/* 列表内容 */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("loading", { ns: "common" })}</span>
            </div>
          )}

          {!loading && skills.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Sparkles size={28} className="mx-auto mb-3 opacity-40" />
              <p className="text-xs">{t("noSkills")}</p>
              <p className="text-xs mt-1">{t("clickToCreate")}</p>
            </div>
          )}

          {skills.map((skill) => (
            <div
              key={skill.name}
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors ${
                activeSkill?.name === skill.name
                  ? "bg-accent"
                  : ""
              }`}
              onClick={() => handleSelect(skill.name)}
            >
              <CodeXml size={14} className="text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono truncate">/{skill.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {skill.preview}
                </div>
              </div>
              <div className="hidden group-hover:flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(skill.name);
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
          <SkillEditor
            name={isCreating ? "" : activeSkill?.name ?? ""}
            content={isCreating ? "" : activeSkill?.content ?? ""}
            isNew={isCreating}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("selectOrCreateSkill")}</p>
              <p className="text-xs mt-1 text-muted-foreground/60">
                {t("skillDesc")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
