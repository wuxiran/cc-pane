import { useState, useCallback, useRef } from "react";
import { SendHorizontal } from "lucide-react";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";
import { useTranslation } from "react-i18next";
import { handleErrorSilent } from "@/utils";

export default function OrchestratorInput() {
  const { t } = useTranslation("sidebar");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const create = useOrchestratorStore((s) => s.create);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      // 获取第一个工作空间的第一个项目路径作为默认
      let projectPath = "";
      let workspaceName: string | undefined;
      for (const ws of workspaces) {
        if (ws.projects && ws.projects.length > 0) {
          projectPath = ws.projects[0].path;
          workspaceName = ws.name;
          break;
        }
      }

      if (!projectPath) {
        console.warn("[orchestrator] No project available to create task binding");
        return;
      }

      await create({
        title: text.length > 80 ? text.slice(0, 80) + "..." : text,
        prompt: text,
        projectPath,
        workspaceName,
      });

      setInput("");
      inputRef.current?.focus();
    } catch (e) {
      handleErrorSilent(e, "create task binding");
    } finally {
      setSending(false);
    }
  }, [input, sending, create, workspaces]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div
      className="shrink-0 px-2 py-2"
      style={{ borderTop: "1px solid var(--app-border)" }}
    >
      <div
        className="flex items-end gap-1 rounded-md px-2 py-1.5"
        style={{
          background: "var(--app-input-bg)",
          border: "1px solid var(--app-border)",
        }}
      >
        <textarea
          ref={inputRef}
          className="flex-1 bg-transparent border-none outline-none resize-none text-xs leading-relaxed"
          style={{ color: "var(--app-text-primary)", minHeight: 20, maxHeight: 80 }}
          placeholder={t("orchestrationPlaceholder", { defaultValue: "Enter task..." })}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={sending}
        />
        <button
          className="shrink-0 p-1 rounded transition-colors disabled:opacity-40"
          style={{ color: "var(--app-accent)" }}
          onClick={handleSubmit}
          disabled={!input.trim() || sending}
          title={t("send", { ns: "common", defaultValue: "Send" })}
        >
          <SendHorizontal className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
