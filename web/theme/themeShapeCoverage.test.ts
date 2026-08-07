// @ts-expect-error Tests run in Node; the frontend tsconfig intentionally omits @types/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

const SURFACES = [
  ["web/components/layout/AppShell.tsx", 'data-shape-surface="app-shell"'],
  ["web/components/TitleBar.tsx", "shape-chrome"],
  ["web/components/ActivityBar.tsx", "shape-surface"],
  ["web/components/Sidebar.tsx", "shape-surface"],
  ["web/components/StatusBar.tsx", "shape-chrome"],
  ["web/components/panes/TabBar.tsx", "shape-chrome"],
  ["web/components/SettingsPanel.tsx", "shape-panel"],
] as const;

describe("theme shape surface coverage", () => {
  it.each(SURFACES)("marks %s with %s", (path, marker) => {
    expect(source(path)).toContain(marker);
  });

  it("marks shared Dialog, Button, and Input primitives", () => {
    expect(source("web/components/ui/dialog.tsx")).toContain("shape-panel");
    expect(source("web/components/ui/button.tsx")).toContain("shape-control");
    expect(source("web/components/ui/input.tsx")).toContain("shape-input");
  });

  it.each([
    "web/components/panes/TerminalView.tsx",
    "web/components/editor/JsonEditor.tsx",
    "web/components/editor/MermaidBlock.tsx",
  ])("keeps content canvas %s outside shape semantics", (path) => {
    expect(source(path)).not.toMatch(/shape-(?:chrome|surface|panel|control|input)/);
  });
});
