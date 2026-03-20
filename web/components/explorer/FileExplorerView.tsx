import { useCallback, useState } from "react";
import { toast } from "sonner";
import { handleError } from "@/utils";
import { FileTree } from "@/components/filetree";
import { useFileTreeStore } from "@/stores";
import FileExplorerToolbar from "./FileExplorerToolbar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface FileExplorerViewProps {
  projectPath: string;
}

export default function FileExplorerView({ projectPath }: FileExplorerViewProps) {
  const [dialogType, setDialogType] = useState<"newFile" | "newDir" | null>(null);
  const [inputValue, setInputValue] = useState("");

  const showHidden = useFileTreeStore((s) => s.showHidden);
  const toggleShowHidden = useFileTreeStore((s) => s.toggleShowHidden);
  const refresh = useFileTreeStore((s) => s.refresh);
  const createFile = useFileTreeStore((s) => s.createFile);
  const createDirectory = useFileTreeStore((s) => s.createDirectory);
  const handleRefresh = useCallback(() => {
    refresh(projectPath).catch((err) => {
      handleError(err, "refresh file tree");
    });
  }, [projectPath, refresh]);

  const handleNewFile = useCallback(() => {
    setInputValue("");
    setDialogType("newFile");
  }, []);

  const handleNewFolder = useCallback(() => {
    setInputValue("");
    setDialogType("newDir");
  }, []);

  const handleDialogSubmit = useCallback(async () => {
    if (!inputValue.trim()) return;
    try {
      if (dialogType === "newFile") {
        await createFile(projectPath, inputValue.trim(), projectPath);
        toast.success(`Created: ${inputValue.trim()}`);
      } else if (dialogType === "newDir") {
        await createDirectory(projectPath, inputValue.trim(), projectPath);
        toast.success(`Created: ${inputValue.trim()}`);
      }
    } catch (err) {
      handleError(err, "create file/directory");
    }
    setDialogType(null);
  }, [dialogType, inputValue, projectPath, createFile, createDirectory]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <FileExplorerToolbar
        showHidden={showHidden}
        onRefresh={handleRefresh}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onToggleHidden={toggleShowHidden}
      />

      <div className="flex-1 overflow-hidden">
        <FileTree
          rootPath={projectPath}
          compact={false}
          onOpenTerminal={undefined}
        />
      </div>

      {/* 新建文件/文件夹对话框 */}
      <Dialog open={dialogType !== null} onOpenChange={() => setDialogType(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogType === "newFile" ? "New File" : "New Folder"}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDialogSubmit()}
            placeholder={dialogType === "newFile" ? "filename.ext" : "folder-name"}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogType(null)}>
              Cancel
            </Button>
            <Button onClick={handleDialogSubmit}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
