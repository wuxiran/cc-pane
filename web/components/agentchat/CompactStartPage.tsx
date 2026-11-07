// 右侧面板窄版启动页：中间一句问话（项目名可点，换项目），底部输入框。
// 输入框上方挂一条浅色上下文条（项目），卡片里左边权限、右边引擎/模型/语音/发送。
// 控件本身由 EnginePicker 传入，这里只管排版——和窗格启动页共用同一套状态与行为。
import type { ReactElement, ReactNode, RefObject } from "react";
import { Bot, Bug, FolderOpen, Hammer, SearchCode, Telescope } from "lucide-react";
import { useTranslation } from "react-i18next";

export const START_SUGGESTIONS = [
  { icon: Telescope, labelKey: "agentChatSuggestExplore", promptKey: "agentChatSuggestExplorePrompt" },
  { icon: Hammer, labelKey: "agentChatSuggestBuild", promptKey: "agentChatSuggestBuildPrompt" },
  { icon: SearchCode, labelKey: "agentChatSuggestReview", promptKey: "agentChatSuggestReviewPrompt" },
  { icon: Bug, labelKey: "agentChatSuggestFix", promptKey: "agentChatSuggestFixPrompt" },
] as const;

interface CompactStartPageProps {
  projectName: string | null;
  cwd: string;
  busy: boolean;
  /** 用给定触发器包一个换项目菜单。 */
  projectMenu: (trigger: ReactElement) => ReactNode;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  permissionMenu: ReactNode;
  engineMenu: ReactNode;
  modelMenu: ReactNode;
  voiceButton: ReactNode;
  sendButton: ReactNode;
  notice: string | null;
  error: string | null;
}

export default function CompactStartPage({
  projectName, cwd, busy, projectMenu, draft, onDraft, onSubmit, textareaRef, placeholder,
  permissionMenu, engineMenu, modelMenu, voiceButton, sendButton, notice, error,
}: CompactStartPageProps) {
  const { t } = useTranslation("panes");
  return (
    <div className="agent-chat-start-page flex h-full flex-col px-3 pb-3" data-testid="compact-start-page">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <Bot className="size-8 text-[var(--app-text-tertiary)]" strokeWidth={1.3} aria-hidden="true" />
        {cwd && projectName ? (
          <h2 className="text-[17px] font-normal leading-snug text-[var(--app-text-primary)]">
            {t("agentChatHeroBefore")}
            {projectMenu(
              <button
                type="button"
                title={cwd}
                disabled={busy}
                className="underline decoration-[var(--app-text-tertiary)] decoration-dotted decoration-1 underline-offset-4 transition-colors hover:decoration-[var(--app-text-primary)]"
              >
                {projectName}
              </button>,
            )}
            {t("agentChatHeroAfter")}
          </h2>
        ) : (
          <>
            <p className="max-w-64 text-sm text-[var(--app-text-tertiary)]">{t("agentChatNoProject")}</p>
            {projectMenu(
              <button
                type="button"
                className="flex items-center gap-2 rounded-full border border-[var(--app-border)] px-3.5 py-1.5 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
              >
                <FolderOpen className="size-3.5" /> {t("agentChatPickCwd")}
              </button>,
            )}
          </>
        )}
      </div>

      {notice && <p role="status" className="mb-2 px-1 text-xs text-[var(--app-text-tertiary)]">{notice}</p>}
      {error && (
        <div className="mb-2 whitespace-pre-wrap break-all rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-bg)] px-3 py-2 text-xs text-[var(--app-status-danger)]">
          {error}
        </div>
      )}

      <div className="agent-chat-start-composer">
        {cwd && projectName && (
          <div className="mx-3 flex h-8 items-center gap-3 rounded-t-xl bg-[var(--app-hover)] px-3 text-xs text-[var(--app-text-secondary)]">
            {projectMenu(
              <button type="button" title={cwd} disabled={busy} className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-[var(--app-text-primary)]">
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate">{projectName}</span>
              </button>,
            )}
          </div>
        )}
        <div className="agent-chat-composer-shell rounded-2xl border border-[var(--app-border)] bg-[var(--app-sidebar)] px-3 pb-2 pt-2.5 shadow-sm transition-[border-color] duration-[var(--dur)] focus-within:border-[var(--app-text-tertiary)]">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder={placeholder}
            rows={2}
            className="agent-chat-composer-input max-h-48 min-h-11 w-full resize-none bg-transparent px-1 text-[length:var(--text-row)] leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
          />
          <div className="mt-1 flex items-center gap-1">
            <div className="shrink-0">{permissionMenu}</div>
            <span className="min-w-0 flex-1" />
            <div className="flex min-w-0 items-center gap-0.5 overflow-hidden [&>*]:min-w-0">
              {engineMenu}
              {modelMenu}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {voiceButton}
              {sendButton}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
