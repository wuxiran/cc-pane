import { forwardRef, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/services/runtime";
import { isLocalAssetPath, resolveRelativeAssetPath } from "@/utils/mdAssetPath";
import MermaidBlock from "./MermaidBlock";

interface MarkdownPreviewProps {
  content: string;
  /** 当前 md 文件的绝对路径：用于解析相对图片路径（不传则不做本地路径转换） */
  filePath?: string;
  /** 分栏滚动同步：预览侧滚动时回调（EditorView 反向驱动 Monaco） */
  onScroll?: (el: HTMLDivElement) => void;
}

function toAssetUrl(absolutePath: string): string {
  return isTauriRuntime()
    ? convertFileSrc(absolutePath)
    : `/api/fs/raw?path=${encodeURIComponent(absolutePath)}`;
}

function mermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const props = child.props as { className?: string; children?: ReactNode };
  if (!/language-mermaid/.test(props.className ?? "")) return null;
  return String(props.children ?? "").trim();
}

// 代码块高亮走 rehype-highlight（仅显式 ```lang 块，不做语言猜测）；
// token 色规则在 index.css 的 .markdown-preview 段（--code-* 内容类别编码色）。
// ```mermaid 块交给 MermaidBlock 懒加载渲染。
const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview({ content, filePath, onScroll }, ref) {
    const urlTransform = (url: string, key: string) => {
      if (key !== "src" || !filePath) return defaultUrlTransform(url);
      const kind = isLocalAssetPath(url);
      if (kind === "windows-abs") return toAssetUrl(url);
      if (kind === "relative") return toAssetUrl(resolveRelativeAssetPath(filePath, url));
      return defaultUrlTransform(url);
    };

    return (
      <div
        ref={ref}
        onScroll={(event) => onScroll?.(event.currentTarget)}
        className="markdown-preview h-full overflow-y-auto px-6 py-4 prose prose-sm dark:prose-invert max-w-none"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
          urlTransform={urlTransform}
          components={{
            pre: ({ children, ...props }) => {
              const mermaid = mermaidSource(children);
              if (mermaid !== null) return <MermaidBlock code={mermaid} />;
              return <pre {...props}>{children}</pre>;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  },
);

export default MarkdownPreview;
