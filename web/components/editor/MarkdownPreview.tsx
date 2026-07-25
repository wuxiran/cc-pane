import { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownPreviewProps {
  content: string;
  /** 分栏滚动同步：预览侧滚动时回调（EditorView 反向驱动 Monaco） */
  onScroll?: (el: HTMLDivElement) => void;
}

// 代码块高亮走 rehype-highlight（仅显式 ```lang 块，不做语言猜测）；
// token 色规则在 index.css 的 .markdown-preview 段（--code-* 内容类别编码色）。
const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview({ content, onScroll }, ref) {
    return (
      <div
        ref={ref}
        onScroll={(event) => onScroll?.(event.currentTarget)}
        className="markdown-preview h-full overflow-y-auto px-6 py-4 prose prose-sm dark:prose-invert max-w-none"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  },
);

export default MarkdownPreview;
