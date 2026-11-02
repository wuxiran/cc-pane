import { Suspense, useState } from "react";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { TabContextMenuProps } from "./TabContextMenuContent";

export type { LayoutMoveTarget, PaneMoveTarget } from "./TabContextMenuContent";
const MenuContent = lazyWithRetry(() => import("./TabContextMenuContent"), "TabContextMenuContent");

/** Only the trigger belongs to startup; menu actions load on first use. */
export default function TabContextMenu(props: TabContextMenuProps) {
  const [opened, setOpened] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return <ContextMenu onOpenChange={(open) => { setMenuOpen(open); if (open) setOpened(true); }}>
    <ContextMenuTrigger asChild>{props.children}</ContextMenuTrigger>
    {/* Keep the owner mounted after closing so fork/review dialogs remain alive. */}
    {opened && <Suspense fallback={null}><MenuContent {...props} menuOpen={menuOpen} /></Suspense>}
  </ContextMenu>;
}
