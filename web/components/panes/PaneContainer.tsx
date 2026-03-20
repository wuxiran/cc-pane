import { memo } from "react";
import type { PaneNode } from "@/types";
import Panel from "./Panel";
import SplitContainer from "./SplitContainer";

interface PaneContainerProps {
  pane: PaneNode;
}

const PaneContainer = memo(function PaneContainer({ pane }: PaneContainerProps) {
  if (pane.type === "panel") {
    return <Panel pane={pane} />;
  }
  return <SplitContainer pane={pane} />;
});

export default PaneContainer;
