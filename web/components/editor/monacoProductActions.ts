// 注入 Monaco 右键菜单的产品动作（从 EditorView 拆出，行数棘轮约束）：
// 复制路径 / 文件树定位（navigation 组）。标签在 mount 时求值（与 Save File 同口径），
// 语言切换后重开编辑器生效。SSH 远程文件不在本地文件树里，不注册定位动作。
import type { editor as MonacoEditor } from "monaco-editor";
import i18n from "@/i18n";
import { useFileTreeStore } from "@/stores";

interface ProductActionContext {
  filePath: string;
  projectPath: string;
  ssh?: boolean;
}

export function registerMonacoProductActions(
  editor: MonacoEditor.IStandaloneCodeEditor,
  { filePath, projectPath, ssh }: ProductActionContext,
): void {
  editor.addAction({
    id: "cc-copy-file-path",
    label: i18n.t("copyFilePath", { ns: "panes" }),
    contextMenuGroupId: "navigation",
    run: () => {
      void navigator.clipboard.writeText(filePath);
    },
  });
  if (ssh) return;
  editor.addAction({
    id: "cc-reveal-in-explorer",
    label: i18n.t("revealInExplorer", { ns: "panes" }),
    contextMenuGroupId: "navigation",
    run: () => {
      useFileTreeStore.getState().revealFile(projectPath, filePath);
    },
  });
}
