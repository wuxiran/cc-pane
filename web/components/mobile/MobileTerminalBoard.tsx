import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send, Terminal } from "lucide-react";
import TerminalTabContent from "@/components/panes/TerminalTabContent";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import type { LayoutEntry, Panel } from "@/types";
import { getActiveTerminalSessionId } from "./mobileUtils";
import type { MobileTerminalState, OpenedWorkspaceProject } from "./types";

interface MobileTerminalBoardProps {
  terminal: MobileTerminalState | null;
  openedProject: OpenedWorkspaceProject | null;
  layouts: LayoutEntry[];
  currentLayoutId?: string;
  panels: Panel[];
  activePaneId?: string;
  onSwitchLayout?: (layoutId: string) => void;
  onSelectPane?: (paneId: string) => void;
  onSelectTab?: (paneId: string, tabId: string) => void;
}

/** 移动端全屏单终端：真实终端渲染复用主 UI 的 TerminalTabContent，本地只保留手机特有的输入条。 */
export default function MobileTerminalBoard({
  terminal,
  openedProject,
  layouts,
  currentLayoutId,
  panels,
  activePaneId,
  onSwitchLayout,
  onSelectPane,
  onSelectTab,
}: MobileTerminalBoardProps) {
  const { t } = useTranslation("mobile");
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSessionId = getActiveTerminalSessionId(terminal?.tab);
  const canSend = Boolean(terminal && activeSessionId);

  // 可见性写侧：移动原型是单终端全屏视图，展示中的 tab 恒 primary/active。
  // 没有这条写侧的话，可见性单源里查不到条目，终端会被当成后台标签降档。
  const mobileTerminalTabId =
    terminal?.tab.contentType === "terminal" && terminal.tab.projectPath ? terminal.tab.id : null;
  useEffect(() => {
    if (!mobileTerminalTabId) return;
    useTabViewStateStore.getState().reportView(mobileTerminalTabId, "primary", "active");
    return () => {
      useTabViewStateStore.getState().removeView(mobileTerminalTabId, "primary");
    };
  }, [mobileTerminalTabId]);

  const writeShortcut = async (text: string) => {
    if (!terminal || !activeSessionId) return;
    setSendError(null);
    try {
      await terminal.onWrite(activeSessionId, text);
    } catch (error) {
      console.error("Failed to write mobile terminal shortcut:", error);
      setSendError(t("terminal.writeFailed"));
    }
  };

  const submitDraft = async () => {
    if (!terminal || !activeSessionId) return;
    const el = inputRef.current;
    const text = (el?.value ?? draft).trim();
    if (!text) return;
    if (el) el.value = ""; // 非受控：直接清 DOM
    setDraft(""); // 同步镜像（驱动发送按钮 disabled）
    setSendError(null);
    try {
      await terminal.onSubmit(activeSessionId, text);
    } catch (error) {
      console.error("Failed to submit mobile terminal input:", error);
      if (el) el.value = text; // 失败回填
      setDraft(text);
      setSendError(t("terminal.sendFailed"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <section className="flex-none rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-1.5">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {layouts.map((layout) => {
            const active = layout.id === currentLayoutId;
            return (
              <button
                key={layout.id}
                type="button"
                onClick={() => onSwitchLayout?.(layout.id)}
                className={`h-8 max-w-[150px] flex-none rounded-md border px-2 text-[12px] font-semibold ${
                  active
                    ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)] text-[var(--app-accent)]"
                    : "border-[var(--app-home-border)] bg-[var(--app-home-surface)] text-[var(--app-text-secondary)]"
                }`}
              >
                <span className="block truncate">{layout.name}</span>
              </button>
            );
          })}
          {layouts.length === 0 && (
            <div className="flex h-8 items-center px-2 text-[12px] text-[var(--app-text-tertiary)]">{t("terminal.noLayouts")}</div>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {panels.map((panel, panelIndex) => {
            const activePane = panel.id === activePaneId;
            const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
            return (
              <button
                key={panel.id}
                type="button"
                onClick={() => {
                  onSelectPane?.(panel.id);
                  if (activeTab) onSelectTab?.(panel.id, activeTab.id);
                }}
                className={`h-8 max-w-[170px] flex-none rounded-md border px-2 text-left text-[11px] ${
                  activePane
                    ? "border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] bg-[var(--app-panel-bg)] text-[var(--app-accent)]"
                    : "border-[var(--app-home-border)] bg-[var(--app-home-surface)] text-[var(--app-text-secondary)]"
                }`}
              >
                <span className="block truncate">
                  {t("layouts.paneLabel", { index: panelIndex + 1 })}{activeTab ? ` / ${activeTab.title}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-terminal-bg)] text-[12px] leading-5 text-[var(--app-terminal-fg)] shadow-inner">
        {terminal?.tab.contentType === "terminal" && terminal.tab.projectPath ? (
          <TerminalTabContent
            tab={terminal.tab}
            layoutActive
            onSessionCreated={terminal.onSessionCreated}
            onSessionExited={terminal.onSessionExited}
            onTerminalRef={terminal.onTerminalRef}
            onReconnect={terminal.onReconnect}
          />
        ) : (
          <div className="flex h-full min-h-[68dvh] flex-col items-center justify-center px-6 text-center">
            <Terminal className="mb-4 h-10 w-10 text-[color-mix(in_srgb,var(--app-terminal-fg)_45%,transparent)]" />
            <h3 className="text-[15px] font-semibold text-[var(--app-terminal-fg)]">{t("terminal.emptyTitle")}</h3>
            <p className="mt-2 max-w-[280px] text-[12px] leading-5 text-[color-mix(in_srgb,var(--app-terminal-fg)_65%,transparent)]">
              {t("terminal.emptyDescription")}
              {openedProject ? ` ${t("terminal.currentSelection", { workspace: openedProject.workspaceName, project: openedProject.projectName })}` : ""}
            </p>
          </div>
        )}
      </section>

      <section className="rounded-md border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-2">
        <div className="flex items-center gap-2">
          <CommandChip label="/" disabled={!canSend} onClick={() => void writeShortcut("/")} />
          <CommandChip label="%" disabled={!canSend} onClick={() => void writeShortcut("%")} />
          <input
            ref={inputRef}
            defaultValue=""
            onChange={(event) => {
              // 非受控输入：onChange 只更新镜像 state（驱动发送按钮），不回写 value。
              // 去掉 value prop 后 React 不再程序化设置 node.value，iOS 粘贴后不会被重置成英文键盘/收起键盘。
              // 合成进行中跳过镜像更新，避免打断 iOS IME 合成。
              if (composingRef.current) return;
              setDraft(event.target.value);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              // 合成结束，提交最终文本（含刚合成出的字符，如 #）。
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              // 合成中按 Enter 是输入法在选词，不应触发发送。
              if (event.key === "Enter" && !composingRef.current && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitDraft();
              }
            }}
            disabled={!canSend}
            placeholder={canSend ? t("terminal.inputPlaceholder") : t("terminal.waitingSession")}
            className="h-10 min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-input-bg)] px-3 text-[13px] text-[var(--app-text-primary)] outline-none transition placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-accent)_25%,transparent)] disabled:cursor-not-allowed disabled:text-[var(--app-text-tertiary)]"
          />
          <button
            type="button"
            aria-label={t("terminal.send")}
            disabled={!canSend || !draft.trim()}
            onClick={() => void submitDraft()}
            className="grid h-10 w-10 flex-none place-items-center rounded-md bg-[var(--app-accent)] text-[var(--primary-foreground)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[var(--app-hover)] disabled:text-[var(--app-text-tertiary)]"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        {sendError && <div className="mt-1 px-1 text-[11px] text-[var(--app-status-danger)]">{sendError}</div>}
      </section>
    </div>
  );
}

function CommandChip({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation("mobile");
  return (
    <button
      type="button"
      aria-label={t("terminal.shortcutLabel", { char: label })}
      disabled={disabled}
      onClick={onClick}
      className="grid h-10 w-10 flex-none place-items-center rounded-md border border-[var(--app-border)] bg-[var(--app-hover)] font-mono text-[18px] font-semibold text-[var(--app-text-secondary)] active:scale-[0.98] disabled:cursor-not-allowed disabled:text-[var(--app-text-tertiary)]"
    >
      {label}
    </button>
  );
}
