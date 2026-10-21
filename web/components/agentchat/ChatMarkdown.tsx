// 聊天气泡的 markdown 渲染：GFM + 代码高亮，走 MarkdownPreview 同一套插件与
// `.markdown-preview` 的 token 色规则（index.css）。不做 mermaid——聊天里罕见。
// 本地图片：agent 回复常引用磁盘截图（`![](C:\...\a.png)` 或项目相对路径），
// src 命中本地路径形态时转 asset URL（与编辑器预览同一套 mdAssetPath/assetUrl）；
// 相对路径以会话 cwd 为基准，拿不到 cwd 就保持原样（不渲染破图链接给默认行为）。
//
// 文件链接路由：agent 提到的文件路径几乎总在行内代码里（`src/foo.rs:42`），
// 命中路径形态的行内 code 渲染成可点击，交给 onOpenFile 打开编辑器并跳行；
// 非 http 的 markdown 链接同样拦截。
import { memo, type ReactNode } from "react";
import type { Element, Root, RootContent } from "hast";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { isLocalAssetPath, resolveRelativeFromDir } from "@/utils/mdAssetPath";
import { toAssetUrl } from "@/utils/assetUrl";
import { isImagePath } from "./chatAttachments";

import { parseFileLink, parseFileRef } from "./chatFileRefs";
import { isAbsolutePath, toFileUri } from "./chatPaths";
export { parseFileRef } from "./chatFileRefs";
export type { ParsedFileRef } from "./chatFileRefs";

declare module "hast" {
  interface ElementData {
    chatLocalPath?: string;
    chatInLink?: boolean;
    chatInPre?: boolean;
  }
}

function childText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" ? child : "")).join("");
  }
  return "";
}

/**
 * markdown 链接/图片目的地里的 Windows 反斜杠路径会被 CommonMark 吃掉反斜杠
 * （`C:\shots\a.png` 解析成 `C:shotsa.png`，不可恢复），解析前先规范成正斜杠。
 * 只动盘符/UNC 开头且含反斜杠的目的地，代码示例等普通文本不受影响。
 */
export function normalizeWindowsLinkDestinations(text: string): string {
  return text.replace(
    /(!?\[[^\]]*\]\()<?((?:[A-Za-z]:\\|\\\\)[^)\s>]*)>?/g,
    (_match, prefix: string, destination: string) =>
      `${prefix}${destination.startsWith("\\\\") ? toFileUri(destination) : destination.replace(/\\/g, "/")}`,
  );
}

/**
 * img src 的本地路径转换：Windows 盘符绝对路径与 Unix 根路径直接转 asset URL；
 * 相对路径以会话 cwd 为基准解析（无 cwd 不转）；data:image 内嵌图放行
 * （defaultUrlTransform 会把 data: 清洗成空串）。http(s) 走默认清洗。
 */
export function buildChatUrlTransform(cwd?: string) {
  return (url: string, key: string, node?: Element): string => {
    if (key !== "src") return parseFileLink(url) ? url : defaultUrlTransform(url);
    const ref = parseFileLink(url);
    const local = ref ? isAbsolutePath(ref.path)
      ? ref.path : cwd ? resolveRelativeFromDir(cwd, ref.path) : null : null;
    if (local && node) node.data = { ...node.data, chatLocalPath: local };
    if (/^file:/i.test(url)) {
      const ref = parseFileLink(url);
      return ref ? toAssetUrl(ref.path) : "";
    }
    if (/^data:image\//i.test(url)) return url;
    const kind = isLocalAssetPath(url);
    if (kind === "windows-abs") return toAssetUrl(url);
    if (kind === "relative" && cwd) return toAssetUrl(resolveRelativeFromDir(cwd, url));
    // Unix 绝对路径（isLocalAssetPath 把 "/" 开头留给站内资源，聊天里它就是本地文件）。
    if (/^\/[^/]/.test(url)) return toAssetUrl(url);
    return defaultUrlTransform(url);
  };
}

/** Keep links and fenced code valid when their children contain file references. */
function markChatAncestors() {
  return (tree: Root) => {
    const walk = (node: Root | RootContent, inLink = false, inPre = false) => {
      if (node.type === "element") {
        node.data = { ...node.data, chatInLink: inLink, chatInPre: inPre };
        inLink ||= node.tagName === "a";
        inPre ||= node.tagName === "pre";
      }
      if ("children" in node) node.children.forEach((child) => walk(child, inLink, inPre));
    };
    walk(tree);
  };
}

interface ChatMarkdownProps {
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
  /** 会话工作目录：解析回复里相对图片路径用（不传则只转绝对路径）。 */
  cwd?: string;
}

export default memo(function ChatMarkdown({ text, onOpenFile, cwd }: ChatMarkdownProps) {
  return (
    <div className="agent-chat-prose markdown-preview min-w-0 max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }], markChatAncestors]}
        urlTransform={buildChatUrlTransform(cwd)}
        components={{
          img: ({ node, src, alt, ...props }) => {
            const path = node?.data?.chatLocalPath;
            const image = <img {...props} src={src} alt={alt ?? ""} loading="lazy" decoding="async" className="max-h-72 max-w-full rounded-lg border border-[var(--app-border)]" />;
            return onOpenFile && typeof path === "string" && !node?.data?.chatInLink
              ? <button type="button" title={path} aria-label={alt || path} className="inline-block max-w-full rounded-lg text-left focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]" onClick={() => onOpenFile(path)}>{image}</button>
              : image;
          },
          code: ({ node, className, children, ...props }) => {
            // 块级代码（有 language- class 或在 pre 内）原样；只处理行内。
            const isBlock = /language-/.test(className ?? "") || node?.data?.chatInPre;
            if (!isBlock && !node?.data?.chatInLink) {
              const ref = parseFileRef(childText(children));
              if (ref) {
                // 图片路径（agent 生成截图/图表后报路径的常见形态）：直接在
                // 对话里显示图片，路径代码保留可点击打开。行内代码不做转义
                // 处理，Windows 路径的反斜杠原样保留，这里规范成正斜杠。
                const kind = isLocalAssetPath(ref.path);
                const absolute = isImagePath(ref.path)
                  ? kind === "windows-abs" || /^\/[^/]/.test(ref.path)
                    ? ref.path.replace(/\\/g, "/")
                    : kind === "relative" && cwd
                      ? resolveRelativeFromDir(cwd, ref.path)
                      : null
                  : null;
                return (
                  <>
                    {absolute ? (
                      <span className="my-1.5 block">
                        {onOpenFile ? <button type="button" aria-label={ref.path} className="max-w-full rounded-lg text-left focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]" onClick={() => onOpenFile(ref.path, ref.line)}>
                          <img src={toAssetUrl(absolute)} alt={ref.path} loading="lazy" decoding="async" className="max-h-72 max-w-full rounded-lg border border-[var(--app-border)]" />
                        </button> : <img
                          src={toAssetUrl(absolute)}
                          alt={ref.path}
                          title={ref.path}
                          loading="lazy" decoding="async"
                          className="max-h-72 max-w-full rounded-lg border border-[var(--app-border)]"
                        />}
                      </span>
                    ) : null}
                    {onOpenFile ? (
                      <button type="button"
                        className="cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:text-[var(--app-icon-active)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
                        title={ref.path}
                        onClick={() => onOpenFile(ref.path, ref.line)}
                      >
                        <code {...props} className={className}>{children}</code>
                      </button>
                    ) : (
                      <code {...props} className={className}>
                        {children}
                      </code>
                    )}
                  </>
                );
              }
            }
            return (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          a: ({ node: _node, href, children, ...props }) => {
            const target = href ?? "";
            if (!target) return <span>{children}</span>;
            if (target.startsWith("#")) return <a {...props} href={target}>{children}</a>;
            if (onOpenFile) {
              const ref = parseFileLink(target);
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
        {normalizeWindowsLinkDestinations(text)}
      </ReactMarkdown>
    </div>
  );
});
