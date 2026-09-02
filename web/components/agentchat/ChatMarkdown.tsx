// 聊天气泡的 markdown 渲染：GFM + 代码高亮，走 MarkdownPreview 同一套插件与
// `.markdown-preview` 的 token 色规则（index.css）。不做 mermaid 与本地图片
// 路径转换——聊天内容不是磁盘上的 md 文件。
//
// 文件链接路由：agent 提到的文件路径几乎总在行内代码里（`src/foo.rs:42`），
// 命中路径形态的行内 code 渲染成可点击，交给 onOpenFile 打开编辑器并跳行；
// 非 http 的 markdown 链接同样拦截。
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/** `src/foo.rs:42`、`C:\a\b.ts`、`./x/y.py:10:5` 这类形态；要求带扩展名防误伤普通词。 */
const FILE_PATH_PATTERN =
  /^(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?(?::\d+)?$/;

export interface ParsedFileRef {
  path: string;
  line?: number;
}

export function parseFileRef(raw: string): ParsedFileRef | null {
  const text = raw.trim();
  if (text.length < 3 || text.length > 512 || /\s/.test(text)) return null;
  const match = FILE_PATH_PATTERN.exec(text);
  if (!match) return null;
  const line = match[1] ? Number(match[1]) : undefined;
  const path = text.replace(/:(\d+)(?::\d+)?$/, "");
  return { path, line };
}

function childText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" ? child : "")).join("");
  }
  return "";
}

interface ChatMarkdownProps {
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
}

export default memo(function ChatMarkdown({ text, onOpenFile }: ChatMarkdownProps) {
  return (
    <div className="markdown-preview prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:text-[12px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          code: ({ className, children, ...props }) => {
            // 块级代码（有 language- class 或在 pre 内）原样；只处理行内。
            const isBlock = /language-/.test(className ?? "");
            if (!isBlock && onOpenFile) {
              const ref = parseFileRef(childText(children));
              if (ref) {
                return (
                  <code
                    {...props}
                    className={`${className ?? ""} cursor-pointer underline decoration-dotted underline-offset-2 hover:text-[var(--app-icon-active)]`}
                    title={ref.path}
                    onClick={() => onOpenFile(ref.path, ref.line)}
                  >
                    {children}
                  </code>
                );
              }
            }
            return (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          a: ({ href, children, ...props }) => {
            const target = href ?? "";
            const isWeb = /^https?:/i.test(target);
            if (!isWeb && onOpenFile) {
              const ref = parseFileRef(target.replace(/^file:\/\//i, ""));
              if (ref) {
                return (
                  <a
                    {...props}
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenFile(ref.path, ref.line);
                    }}
                  >
                    {children}
                  </a>
                );
              }
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
