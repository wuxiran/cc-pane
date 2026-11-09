// 面板区的布局舞台：只挂载「本次会话访问过且未因久未访问被卸载」的布局（issue #43）。
// 挂载中的非当前布局仍是 display:none 的 keep-alive，切回即显示；未挂载的布局切入时
// 按首次访问重建，数据来自 panes store，终端 attach 到 daemon 里仍在跑的会话。
import { useEffect, useMemo } from "react";
import { PaneContainer } from "@/components/panes";
import StarredPanel from "@/components/panes/StarredPanel";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import type { LayoutEntry, PaneNode } from "@/types";
import { layoutsHaveAgentChat } from "./layoutMountPolicy";
import { useLazyLayoutMount } from "./useLazyLayoutMount";

interface LayoutStageProps {
  layouts: readonly LayoutEntry[];
  currentLayoutId: string;
  /** 当前布局的实时分屏树（store 里当前布局的 layouts[i].rootPane 可能滞后）。 */
  rootPane: PaneNode;
  /** 面板区本身是否可见（panes 视图激活且处于 panel 显示模式）。 */
  stageVisible: boolean;
}

export default function LayoutStage({
  layouts,
  currentLayoutId,
  rootPane,
  stageVisible,
}: LayoutStageProps) {
  const mounted = useLazyLayoutMount(layouts, currentLayoutId);
  const hasAgentChat = useMemo(() => layoutsHaveAgentChat(layouts), [layouts]);

  // agent-chat 的事件监听原本由标签挂载时顺手建立；未访问布局里的会话不挂载，
  // 这里兜底建立，保证后台会话事件照常写进 store（幂等）。动态 import：没有
  // agent-chat 标签时不把 ACP 事件桥拉进首屏模块图。
  useEffect(() => {
    if (!hasAgentChat) return;
    void import("@/stores/agentChatEvents")
      .then(({ ensureAgentChatListener }) => ensureAgentChatListener())
      .catch((error: unknown) => console.warn("[LayoutStage] agent chat listener import failed:", error));
  }, [hasAgentChat]);

  return (
    <>
      {layouts.map((layout) => {
        const isCurrent = layout.id === currentLayoutId;
        // 首次切入当帧 mounted 尚未含当前布局（effect 晚一拍），用 isCurrent 兜底立即挂载。
        if (!isCurrent && !mounted.has(layout.id)) return null;
        return (
          <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent && stageVisible}>
            <div
              className="h-full w-full"
              data-layout-stage-id={layout.id}
              style={{ display: isCurrent ? "block" : "none" }}
            >
              {layout.kind === "starred" ? (
                <StarredPanel />
              ) : (
                <PaneContainer pane={isCurrent ? rootPane : layout.rootPane} />
              )}
            </div>
          </LayoutVisibilityContext.Provider>
        );
      })}
    </>
  );
}
