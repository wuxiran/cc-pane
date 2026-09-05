// Monaco 懒加载边界。
//
// monaco-editor（构建产物 ~3.6MB / gzip ~950kB）曾经是 main.tsx 的静态依赖，导致
// 首屏必须同步下载并求值整个 monaco。现在收敛到本模块：只有 EditorView 真正要渲染
// 编辑器时，才通过 `lazyWithRetry(() => import("./MonacoCodeEditor"))` 拉取这个 chunk。
//
// `loader.config({ monaco })` 必须发生在任何 `<Editor>` 挂载之前（否则 @monaco-editor/react
// 会尝试从 CDN 加载，Release CSP 会拦截）。放在模块顶层即可：模块本身加载完成 = 配置完成，
// 时序上严格先于其中导出的组件首次渲染。
import Editor, { loader, type EditorProps } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

loader.config({ monaco });

export type { EditorProps };

export default function MonacoCodeEditor(props: EditorProps) {
  return <Editor {...props} />;
}
