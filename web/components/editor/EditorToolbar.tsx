import { useCallback } from "react";
import { Save, Undo2, Redo2, Eye, SplitSquareHorizontal, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type PreviewMode = "edit" | "preview" | "split";

interface EditorToolbarProps {
  language: string;
  dirty: boolean;
  readOnly?: boolean;
  isMarkdown: boolean;
  previewMode: PreviewMode;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPreviewModeChange: (mode: PreviewMode) => void;
}

export default function EditorToolbar({
  language,
  dirty,
  readOnly,
  isMarkdown,
  previewMode,
  onSave,
  onUndo,
  onRedo,
  onPreviewModeChange,
}: EditorToolbarProps) {
  const cyclePreview = useCallback(() => {
    const modes: PreviewMode[] = ["edit", "preview", "split"];
    const idx = modes.indexOf(previewMode);
    onPreviewModeChange(modes[(idx + 1) % modes.length]);
  }, [previewMode, onPreviewModeChange]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1 px-2 h-[26px] border-b text-xs" style={{ background: "var(--editor-bg)" }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onSave}
              disabled={!dirty || readOnly}
            >
              <Save size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save (Ctrl+S)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onUndo}
            >
              <Undo2 size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onRedo}
            >
              <Redo2 size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
        </Tooltip>

        {isMarkdown && (
          <>
            <div className="w-px h-4 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={previewMode === "edit" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => onPreviewModeChange("edit")}
                >
                  <Code2 size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={previewMode === "preview" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => onPreviewModeChange("preview")}
                >
                  <Eye size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Preview</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={previewMode === "split" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-5 w-5"
                  onClick={cyclePreview}
                >
                  <SplitSquareHorizontal size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Split Preview</TooltipContent>
            </Tooltip>
          </>
        )}

        <div className="flex-1" />

        {dirty && (
          <span className="text-[11px] mr-1" style={{ color: "var(--app-warning)" }}>Modified</span>
        )}
        <span className="text-muted-foreground text-[11px]">{language}</span>
      </div>
    </TooltipProvider>
  );
}
