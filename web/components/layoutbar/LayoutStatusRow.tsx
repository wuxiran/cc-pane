import { useMemo } from "react";
import LayoutStatusGrid from "./LayoutStatusGrid";
import { deriveLayoutStatusSummary } from "./layoutStatusSummary";
import type { PaneNode, TerminalStatusInfo } from "@/types";

// 自带派生的状态桁。给「手上只有 rootPane 没有 summary」的调用方用
// （紧凑档卡片、corner 面板行），舒适档卡片走 LayoutStatusGrid 直传 summary，
// 避免同一棵树派生两次。
//
// 取代了此前的 LayoutStatusDots：那个按 **pane** 聚合（每 pane 一个点、超 6 个
// 显 +N），与舒适档的 **session** 计数是两套口径——同一张卡换个密度语义就变。
export default function LayoutStatusRow({
  rootPane,
  statusMap,
}: {
  rootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
}) {
  const summary = useMemo(
    () => deriveLayoutStatusSummary(rootPane, statusMap),
    [rootPane, statusMap],
  );
  return <LayoutStatusGrid summary={summary} />;
}
