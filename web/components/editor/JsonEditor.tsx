import { useRef, useEffect, useMemo } from "react";
import { EditorView, basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { placeholder } from "@codemirror/view";
import { linter, type Diagnostic } from "@codemirror/lint";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useTranslation } from "react-i18next";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";
import { formatJSON } from "@/utils/json";

/** 亮色模式语法高亮 — 鲜明的 JSON 颜色 */
const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.string, color: "#22863a" },         // 绿色 — 字符串值
    { tag: tags.number, color: "#005cc5" },          // 蓝色 — 数字
    { tag: tags.bool, color: "#d73a49" },            // 红色 — true/false
    { tag: tags.null, color: "#6f42c1" },            // 紫色 — null
    { tag: tags.propertyName, color: "#e36209" },    // 橙色 — 键名
    { tag: tags.punctuation, color: "#586069" },     // 灰色 — 括号/逗号
  ]),
);

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  height?: string | number;
  readOnly?: boolean;
  showValidation?: boolean;
}

export default function JsonEditor({
  value,
  onChange,
  placeholder: placeholderText = "",
  rows = 12,
  height,
  readOnly = false,
  showValidation = true,
}: JsonEditorProps) {
  const { t } = useTranslation("settings");
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // 自动检测暗色主题
  const isDark = useMemo(() => {
    return document.documentElement.classList.contains("dark");
  }, []);

  // JSON linter
  const jsonLinter = useMemo(
    () =>
      linter((view) => {
        const diagnostics: Diagnostic[] = [];
        if (!showValidation) return diagnostics;

        const doc = view.state.doc.toString();
        if (!doc.trim()) return diagnostics;

        try {
          JSON.parse(doc);
        } catch (e) {
          const message =
            e instanceof SyntaxError ? e.message : t("jsonInvalid");
          diagnostics.push({
            from: 0,
            to: doc.length,
            severity: "error",
            message,
          });
        }
        return diagnostics;
      }),
    [showValidation, t],
  );

  // 创建编辑器
  useEffect(() => {
    if (!editorRef.current) return;

    const minHeightPx = height ? undefined : Math.max(1, rows) * 18;

    const baseTheme = EditorView.baseTheme({
      ".cm-editor": {
        border: "1px solid hsl(var(--border))",
        borderRadius: "0.375rem",
        background: "transparent",
      },
      ".cm-editor.cm-focused": {
        outline: "none",
        borderColor: "hsl(var(--primary))",
      },
      ".cm-scroller": {
        background: "transparent",
      },
      ".cm-gutters": {
        background: "transparent",
        borderRight: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
      ".cm-activeLine": {
        background: "hsl(var(--primary) / 0.08)",
      },
      ".cm-activeLineGutter": {
        background: "hsl(var(--primary) / 0.08)",
      },
    });

    const heightValue = height
      ? typeof height === "number"
        ? `${height}px`
        : height
      : undefined;

    const sizingTheme = EditorView.theme({
      "&": heightValue
        ? { height: heightValue }
        : { minHeight: `${minHeightPx}px` },
      ".cm-scroller": { overflow: "auto" },
      ".cm-content": {
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: "13px",
      },
    });

    const extensions = [
      basicSetup,
      json(),
      placeholder(placeholderText || ""),
      baseTheme,
      sizingTheme,
      jsonLinter,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
    ];

    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true));
    }

    if (!isDark) {
      extensions.push(lightHighlight);
    }

    if (isDark) {
      extensions.push(oneDark);
      // 覆盖 oneDark 的边框样式
      extensions.push(
        EditorView.theme({
          ".cm-editor": {
            border: "1px solid hsl(var(--border))",
            borderRadius: "0.375rem",
            background: "transparent",
          },
          ".cm-editor.cm-focused": {
            outline: "none",
            borderColor: "hsl(var(--primary))",
          },
          ".cm-scroller": { background: "transparent" },
          ".cm-gutters": {
            background: "transparent",
            borderRight: "1px solid hsl(var(--border))",
            color: "hsl(var(--muted-foreground))",
          },
          ".cm-activeLine": {
            background: "hsl(var(--primary) / 0.08)",
          },
          ".cm-activeLineGutter": {
            background: "hsl(var(--primary) / 0.08)",
          },
        }),
      );
    }

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark, rows, height, readOnly, jsonLinter]);

  // 外部值更新时同步编辑器
  useEffect(() => {
    if (viewRef.current && viewRef.current.state.doc.toString() !== value) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: value,
        },
      });
    }
  }, [value]);

  const handleFormat = () => {
    if (!viewRef.current) return;
    const currentValue = viewRef.current.state.doc.toString();
    if (!currentValue.trim()) return;
    try {
      const formatted = formatJSON(currentValue);
      onChange(formatted);
      toast.success(t("formatSuccess"));
    } catch {
      toast.error(t("formatError"));
    }
  };

  return (
    <div className="w-full">
      <div ref={editorRef} className="w-full" />
      {!readOnly && (
        <button
          type="button"
          onClick={handleFormat}
          className="mt-1.5 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded hover:bg-[var(--app-hover)] transition-colors"
          style={{ color: "var(--app-text-secondary)" }}
        >
          <Wand2 className="w-3 h-3" />
          {t("formatBtn")}
        </button>
      )}
    </div>
  );
}
