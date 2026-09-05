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

// 语言服务 worker：不配置 MonacoEnvironment.getWorker 时 monaco 每次开编辑器都会
// 抛 "You must define a function MonacoEnvironment.getWorkerUrl or getWorker"
// （编辑器本体可渲染，但 JSON/TS 语言服务全废，且被前端崩溃上报器记为 window-error）。
//
// 每个分支都必须内联**完全静态**的 new URL(...)：Vite 构建期据此逐个发射 worker 资产；
// 模板字符串/变量（哪怕封装进函数）会退化成对整个 esm/vs 目录的动态 glob（数千文件
// 进产物）。getWorker 只在真实编辑器挂载时执行，Vitest 里零模块级副作用（?worker
// 导入会被 vitest 的 monaco 别名改写坏，故不用）。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new Worker(
          new URL("../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: 'module' });
      case "typescript":
      case "javascript":
        return new Worker(
          new URL("../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: 'module' });
      case "css":
      case "scss":
      case "less":
        return new Worker(
          new URL("../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: 'module' });
      case "html":
      case "handlebars":
      case "razor":
        return new Worker(
          new URL("../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: 'module' });
      default:
        return new Worker(
          new URL("../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: 'module' });
    }
  },
};

loader.config({ monaco });

export type { EditorProps };

export default function MonacoCodeEditor(props: EditorProps) {
  return <Editor {...props} />;
}
