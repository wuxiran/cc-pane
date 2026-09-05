/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: Record<string, unknown>;
  /** Monaco 语言服务 worker 解析器（web/components/editor/MonacoCodeEditor.tsx 赋值） */
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}
