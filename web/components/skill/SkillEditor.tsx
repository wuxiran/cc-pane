import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SkillEditorProps {
  name: string;
  content: string;
  isNew?: boolean;
  onSave: (name: string, content: string) => void;
  onCancel: () => void;
}

export default function SkillEditor({
  name: initialName,
  content: initialContent,
  isNew,
  onSave,
  onCancel,
}: SkillEditorProps) {
  const { t } = useTranslation("dialogs");
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);

  useEffect(() => {
    setName(initialName);
    setContent(initialContent);
  }, [initialName, initialContent]);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;
    onSave(name.trim(), content);
  }, [name, content, onSave]);

  // Ctrl+S 保存
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [handleSave]);

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border">
        {isNew ? (
          <div className="flex-1 space-y-1">
            <Label className="text-xs">{t("skillCommandName")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("skillCommandNamePlaceholder")}
              className="h-8 text-sm font-mono"
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center gap-2">
            <span className="text-sm font-medium font-mono">/{name}</span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X size={14} className="mr-1" />
            {t("cancel", { ns: "common" })}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!name.trim()}>
            <Save size={14} className="mr-1" />
            {t("save", { ns: "common" })}
          </Button>
        </div>
      </div>

      {/* 编辑区 */}
      <div className="flex-1 overflow-hidden">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full h-full p-4 text-sm font-mono bg-background resize-none focus:outline-none border-none"
          placeholder={t("skillEditorPlaceholder")}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
