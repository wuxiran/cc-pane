import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { toastOk } from "@/lib/feedback";
import { lazyWithRetry } from "@/lib/lazyRetry";
import type { EditorProps } from "./MonacoCodeEditor";

// Monaco 本体走独立 chunk 懒加载（见 ./MonacoCodeEditor 顶部注释）；
// fallback 与文件加载态同款样式，避免编辑器区域在 chunk 取回期间跳动。
const MonacoCodeEditor = lazyWithRetry<EditorProps>(
  () => import("./MonacoCodeEditor"),
  "MonacoCodeEditor",
);
import i18n from "@/i18n";
import { handleError, getErrorMessage } from "@/utils";
import { filesystemService } from "@/services/filesystemService";
import { sshFileService } from "@/services/sshFileService";
import { usePanesStore, useRightDockStore, useSshRemoteFilesStore } from "@/stores";
import { registerMonacoProductActions } from "./monacoProductActions";
import type { EditorTab } from "@/stores/useEditorTabsStore";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { reportTabViewState } from "@/lib/tabLifecycle/tabViewState";
import { useThemeStore } from "@/stores/useThemeStore";
import EditorToolbar from "./EditorToolbar";
import EditorBreadcrumb from "./EditorBreadcrumb";
import MarkdownPreview from "./MarkdownPreview";
import ImagePreview from "./ImagePreview";
import { isImageFile } from "@/lib/fileTypes";

/** 支持预览的图片扩展名（SVG 不纳入，保持 Monaco XML 编辑） */
/** 文件扩展名 → Monaco 语言 ID */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  sql: "sql",
  graphql: "graphql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  swift: "swift",
  kt: "kotlin",
  dart: "dart",
  r: "r",
};

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() || "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  return EXTENSION_LANGUAGE_MAP[ext] || "plaintext";
}

type PreviewMode = "edit" | "preview" | "split";


const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

interface EditorViewProps {
  filePath: string;
  projectPath: string;
  tabId?: string;
  paneId?: string;
  /** 独立面板模式下的 dirty 状态回调（替代 paneId/tabId） */
  onDirtyChange?: (dirty: boolean) => void;
  ssh?: NonNullable<EditorTab["ssh"]>;
}

export default function EditorView({
  filePath,
  projectPath,
  tabId,
  paneId,
  onDirtyChange,
  ssh,
}: EditorViewProps) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState<"path" | "encoding" | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("edit");
  const [remoteImageUrl, setRemoteImageUrl] = useState<string | null>(null);
  const [remoteImageSize, setRemoteImageSize] = useState<number | null>(null);
  const lastSavedMtime = useRef<string | null>(null);
  // 分栏滚动同步：previewModeRef 供 Monaco 事件闭包读最新值；syncLock 防两侧互相回声
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewModeRef = useRef<PreviewMode>("edit");
  const syncLock = useRef<"editor" | "preview" | null>(null);

  const isDark = useThemeStore((s) => s.isDark);
  const setTabDirty = usePanesStore((s) => s.setTabDirty);
  const revealRequest = useEditorRevealStore((state) => state.requests[filePath]);

  const language = getLanguageFromPath(filePath);
  const isMarkdown = language === "markdown";
  const dirty = content !== originalContent;

  // 同步 dirty 状态到 tab
  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(dirty);
    } else if (paneId && tabId) {
      setTabDirty(paneId, tabId, dirty);
    }
  }, [dirty, paneId, tabId, setTabDirty, onDirtyChange]);

  // 检测只读路径
  const isReadOnlyPath = useCallback((p: string) => {
    const normalized = p.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.includes("/node_modules/") ||
      normalized.includes("/.git/") ||
      normalized.includes("/target/")
    );
  }, []);

  // 加载文件
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRemoteImageUrl(null);
    setRemoteImageSize(null);

    (async () => {
      try {
        if (isImageFile(filePath)) {
          if (ssh) {
            const image = await sshFileService.readImage(ssh.machineId, filePath);
            if (cancelled) return;
            setRemoteImageUrl(`data:${image.mimeType};base64,${image.dataBase64}`);
            setRemoteImageSize(image.size);
          }
          setLoading(false);
          return;
        }

        if (!ssh) {
          const info = await filesystemService.getEntryInfo(filePath);
          if (info.size > MAX_FILE_SIZE) {
            setError(`File too large (${(info.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`);
            setLoading(false);
            return;
          }
        }

        const result = ssh
          ? await sshFileService.readFile(ssh.machineId, filePath)
          : await filesystemService.readFile(filePath);
        if (cancelled) return;

        if (result.encoding === "binary") {
          setError("Binary file — cannot preview");
          setLoading(false);
          return;
        }

        setContent(result.content);
        setOriginalContent(result.content);
        const pathReadOnly = !ssh && isReadOnlyPath(filePath);
        const encodingReadOnly = result.encoding !== "utf-8";
        setReadOnly(pathReadOnly || encodingReadOnly);
        setReadOnlyReason(pathReadOnly ? "path" : encodingReadOnly ? "encoding" : null);

        if (!ssh) {
          const entryInfo = await filesystemService.getEntryInfo(filePath);
          lastSavedMtime.current = entryInfo.modified;
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to load file: ${getErrorMessage(err)}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, isReadOnlyPath, ssh]);

  // 保存
  const handleSave = useCallback(async () => {
    if (readOnly || !dirty) return;

    try {
      // 冲突检测：比对 mtime
      if (!ssh && lastSavedMtime.current) {
        const current = await filesystemService.getEntryInfo(filePath);
        if (current.modified && current.modified !== lastSavedMtime.current) {
          const overwrite = window.confirm(
            "File has been modified externally. Overwrite?"
          );
          if (!overwrite) return;
        }
      }

      if (ssh) await sshFileService.writeFile(ssh.machineId, filePath, content);
      else await filesystemService.writeFile(filePath, content);
      setOriginalContent(content);

      if (!ssh) {
        const info = await filesystemService.getEntryInfo(filePath);
        lastSavedMtime.current = info.modified;
      }

      toastOk(i18n.t("fileSaved", { ns: "editor" }));
    } catch (err) {
      handleError(err, "save file");
    }
  }, [filePath, content, readOnly, dirty, ssh]);

  const handleRemoteBreadcrumbNavigate = useCallback((path: string) => {
    if (!ssh) return;
    useSshRemoteFilesStore.getState().openMachine(ssh.machineId, path);
    useRightDockStore.setState({ visible: true, activeView: "sshFiles" });
  }, [ssh]);

  useEffect(() => {
    previewModeRef.current = previewMode;
  }, [previewMode]);

  // 编辑侧滚动 → 预览侧按比例跟随（仅分栏模式）
  const syncPreviewFromEditor = useCallback(() => {
    if (previewModeRef.current !== "split" || syncLock.current === "preview") return;
    const editor = editorRef.current;
    const preview = previewRef.current;
    if (!editor || !preview) return;
    const editorMax = editor.getScrollHeight() - editor.getLayoutInfo().height;
    const previewMax = preview.scrollHeight - preview.clientHeight;
    if (editorMax <= 0 || previewMax <= 0) return;
    syncLock.current = "editor";
    preview.scrollTop = (editor.getScrollTop() / editorMax) * previewMax;
    requestAnimationFrame(() => {
      syncLock.current = null;
    });
  }, []);

  // 预览侧滚动 → 编辑侧按比例跟随
  const handlePreviewScroll = useCallback((el: HTMLDivElement) => {
    if (previewModeRef.current !== "split" || syncLock.current === "editor") return;
    const editor = editorRef.current;
    if (!editor) return;
    const previewMax = el.scrollHeight - el.clientHeight;
    const editorMax = editor.getScrollHeight() - editor.getLayoutInfo().height;
    if (previewMax <= 0 || editorMax <= 0) return;
    syncLock.current = "preview";
    editor.setScrollTop((el.scrollTop / previewMax) * editorMax);
    requestAnimationFrame(() => {
      syncLock.current = null;
    });
  }, []);

  // Monaco mount
  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      setEditorMounted(true);
      editor.onDidScrollChange(syncPreviewFromEditor);

      // 光标位置上报（docs/78 批4 的 onPersist）：视图状态活在组件实例里，
      // 而销毁管线必须在组件**可能从未挂载**时也能工作，所以只能由活着的组件
      // 持续上报，关闭时由登记表去取。无 tabId（独立面板模式）时不上报。
      if (tabId) {
        editor.onDidChangeCursorPosition((event) => {
          reportTabViewState(tabId, {
            editorCursor: {
              line: event.position.lineNumber,
              column: event.position.column,
            },
          });
        });
      }

      // Ctrl+S 快捷键
      editor.addAction({
        id: "save-file",
        label: "Save File",
        keybindings: [
          // eslint-disable-next-line no-bitwise
          2048 | 49, // monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS
        ],
        run: () => {
          handleSave();
        },
      });

      // 产品动作注入 Monaco 右键菜单（复制路径 / 文件树定位）
      registerMonacoProductActions(editor, { filePath, projectPath, ssh: Boolean(ssh) });
    },
    [handleSave, syncPreviewFromEditor, tabId, filePath, projectPath, ssh]
  );

  useEffect(() => {
    if (!revealRequest || loading || !editorMounted) return;
    if (isMarkdown && previewMode === "preview") {
      setPreviewMode("edit");
      return;
    }

    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const lineNumber = Math.min(Math.max(revealRequest.line, 1), model.getLineCount());
    const column = Math.min(
      Math.max(revealRequest.column ?? 1, 1),
      model.getLineMaxColumn(lineNumber),
    );
    const position = { lineNumber, column };
    editor.setPosition(position);
    editor.revealPositionInCenterIfOutsideViewport(position);
    editor.focus();
    useEditorRevealStore.getState().acknowledge(filePath, revealRequest.requestId);
  }, [editorMounted, filePath, isMarkdown, loading, previewMode, revealRequest]);

  useEffect(() => {
    if (!revealRequest) return;
    if (isImageFile(filePath) || (!loading && error)) {
      useEditorRevealStore.getState().acknowledge(filePath, revealRequest.requestId);
    }
  }, [error, filePath, loading, revealRequest]);

  // 编辑器内容变化
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        setContent(value);
      }
    },
    []
  );

  // 工具栏操作
  const handleUndo = useCallback(() => {
    editorRef.current?.trigger("toolbar", "undo", null);
  }, []);

  const handleRedo = useCallback(() => {
    editorRef.current?.trigger("toolbar", "redo", null);
  }, []);

  // 图片文件 → 渲染 ImagePreview 组件
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading file...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  if (isImageFile(filePath)) {
    return (
      <ImagePreview
        filePath={filePath}
        projectPath={projectPath}
        sourceUrl={ssh ? remoteImageUrl ?? undefined : undefined}
        sourceFileSize={ssh ? remoteImageSize ?? ssh.size : undefined}
        sourceLabel={ssh?.machineName}
        onNavigate={ssh ? handleRemoteBreadcrumbNavigate : undefined}
      />
    );
  }

  const showEditor = previewMode === "edit" || previewMode === "split" || !isMarkdown;
  const showPreview = isMarkdown && (previewMode === "preview" || previewMode === "split");

  return (
    // 在 pane 内渲染时，Panel 的标签栏是 absolute 浮动的（Notch 布局），内容区从 y=0
    // 铺满并被它盖住——工具栏和面包屑必须自己让出这段高度，否则会和标签重叠。
    // 变量只由 Panel 定义，故 FileEditorPanel（文件模式）下回落到 0px，同一份代码通用。
    // 同 TerminalView 的处理方式。
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ paddingTop: "var(--notch-bar-height, 0px)" }}
    >
      <EditorToolbar
        language={language}
        dirty={dirty}
        readOnly={readOnly}
        isMarkdown={isMarkdown}
        previewMode={previewMode}
        onSave={handleSave}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onPreviewModeChange={setPreviewMode}
      />
      <EditorBreadcrumb
        filePath={filePath}
        sourceLabel={ssh?.machineName}
        onNavigate={ssh ? handleRemoteBreadcrumbNavigate : undefined}
      />

      <div className="flex-1 flex overflow-hidden">
        {showEditor && (
          <div className={showPreview ? "w-1/2 border-r" : "flex-1"}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Loading editor...
                </div>
              }
            >
              <MonacoCodeEditor
                height="100%"
                language={language}
                value={content}
                theme={isDark ? "vs-dark" : "vs"}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                options={{
                  readOnly,
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: "on",
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  renderWhitespace: "selection",
                  bracketPairColorization: { enabled: true },
                }}
              />
            </Suspense>
          </div>
        )}

        {showPreview && (
          <div className={showEditor ? "w-1/2" : "flex-1"}>
            <MarkdownPreview
              ref={previewRef}
              content={content}
              filePath={filePath}
              onScroll={handlePreviewScroll}
            />
          </div>
        )}
      </div>

      {readOnly && (
        <div className="px-2 py-0.5 text-[10px] border-t" style={{ color: "var(--app-status-warning)", background: "var(--app-status-warning-bg)" }}>
          {readOnlyReason === "encoding"
            ? "Read-only (non UTF-8 encoding)"
            : "Read-only (protected path)"}
        </div>
      )}
    </div>
  );
}
