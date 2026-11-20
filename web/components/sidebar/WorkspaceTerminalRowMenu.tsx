// 侧栏「运行中的终端」行的右键菜单：重命名 / 置顶 / 分叉 / 复制 / 新窗口打开 / 关闭。
// 动作全部复用标签上的既有实现：置顶 = 固定标签（同时排到列表最前），关闭走 close-tab 事件
// （与点 × 同一条路径：pinned 保护、忙碌确认、会话回收都在 Panel 里）。
import { Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, GitFork, Pencil, Pin, PinOff, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toastErr, toastOk } from "@/lib/feedback";
import { canPopOutTerminalTab, popOutTerminalTab } from "@/components/panes/popOutTerminalTab";
import { focusTab } from "@/hooks/useFocusTab";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { CLOSE_ACTIVE_TAB_EVENT } from "@/components/panes/useTabClosing";
import { terminalForkSource } from "@/services/chatForkService";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";
import { asTabId } from "@/types/ids";

const TerminalForkDialog = lazyWithRetry(() => import("@/components/chatfork/TerminalForkDialog"), "TerminalForkDialog");

interface Props {
  tabId: string;
  children: React.ReactNode;
  onRename: () => void;
}

function locate(tabId: string) {
  return usePanesStore.getState().findTabAcrossLayouts(tabId);
}

/** 只认当前布局的 pane 树的动作（固定、关闭）先切过去再做。 */
function focusAndLocate(tabId: string) {
  if (!focusTab(asTabId(tabId))) return null;
  return locate(tabId);
}

function collectResumeId(tab: Tab): string | null {
  const resumeId = terminalForkSource(tab)?.resumeId ?? tab.resumeId;
  return resumeId && resumeId !== "new" ? resumeId : null;
}

async function copyText(text: string, okLabel: string, failLabel: (error: string) => string) {
  try {
    await navigator.clipboard.writeText(text);
    toastOk(okLabel);
  } catch (error) {
    toastErr(failLabel(String(error)));
  }
}

export default function WorkspaceTerminalRowMenu({ tabId, children, onRename }: Props) {
  const { t } = useTranslation("sidebar");
  const [tab, setTab] = useState<Tab | null>(null);
  const [forkOpen, setForkOpen] = useState(false);

  const forkSource = tab ? terminalForkSource(tab) : null;
  const resumeId = tab ? collectResumeId(tab) : null;
  const copied = t("terminalRowMenu.copied");
  const copyFailed = (error: string) => t("copyFailed", { error });

  return (
    <>
      {forkOpen && (
        <Suspense fallback={null}>
          <TerminalForkDialog open={forkOpen} onOpenChange={setForkOpen} tabId={tabId} />
        </Suspense>
      )}
      <ContextMenu onOpenChange={(open) => { if (open) setTab(locate(tabId)?.tab ?? null); }}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        {tab && (
          <ContextMenuContent
            className="w-52 rounded-2xl p-1.5"
            // 关闭时不把焦点还给行按钮：选「重命名」后行已换成输入框，抢回焦点会立刻 blur 掉编辑
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <ContextMenuItem onSelect={onRename}>
              <Pencil /> {t("terminalRowMenu.rename")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                const location = focusAndLocate(tabId);
                if (location) usePanesStore.getState().togglePinTab(location.panel.id, tabId);
              }}
            >
              {tab.pinned ? <PinOff /> : <Pin />} {tab.pinned ? t("terminalRowMenu.unpin") : t("terminalRowMenu.pin")}
            </ContextMenuItem>
            {forkSource && !forkSource.ssh && (
              <ContextMenuItem onSelect={() => setForkOpen(true)}>
                <GitFork /> {t("terminalRowMenu.fork")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger><Copy /> {t("terminalRowMenu.copy")}</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                <ContextMenuItem
                  disabled={!resumeId}
                  onSelect={() => { if (resumeId) void copyText(resumeId, copied, copyFailed); }}
                >
                  {t("terminalRowMenu.copySessionId")}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!tab.projectPath}
                  onSelect={() => void copyText(tab.projectPath, copied, copyFailed)}
                >
                  {t("terminalRowMenu.copyWorkingDir")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {canPopOutTerminalTab(tab) && (
              <ContextMenuItem
                onSelect={() => {
                  const location = locate(tabId);
                  if (!location) return;
                  popOutTerminalTab(location.tab, location.panel.id).catch((error) => {
                    toastErr(t("terminalRowMenu.popOutFailed", { error: String(error) }));
                  });
                }}
              >
                <ExternalLink /> {t("terminalRowMenu.popOut")}
              </ContextMenuItem>
            )}
            {!tab.pinned && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onSelect={() => {
                    if (focusAndLocate(tabId)) window.dispatchEvent(new Event(CLOSE_ACTIVE_TAB_EVENT));
                  }}
                >
                  <X /> {t("terminalRowMenu.close")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        )}
      </ContextMenu>
    </>
  );
}
