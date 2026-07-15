import { describe, expect, it } from "vitest";
import { collectStarredMirrorTiles, mirrorGridClass } from "./starredMirrors";
import type { StarredShortcutSource } from "./starredMirrors";
import type { Tab, TerminalPaneNode } from "@/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    title: "api",
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "D:/repo/api",
    sessionId: "sess-1",
    starred: true,
    ...overrides,
  } as Tab;
}

function shortcut(tab: Tab, layoutName = "工作区A"): StarredShortcutSource {
  return { layoutId: "layout-1", layoutName, paneId: "pane-1", tab };
}

describe("collectStarredMirrorTiles", () => {
  it("maps a plain terminal tab to one tile keyed by sessionId", () => {
    const tiles = collectStarredMirrorTiles([shortcut(makeTab())]);

    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({
      tabId: "tab-1",
      sessionId: "sess-1",
      layoutName: "工作区A",
      projectPath: "D:/repo/api",
    });
    expect(tiles[0].key).toBe("tab-1:main:sess-1");
  });

  it("changes the key when the session id changes (restore → remount)", () => {
    const before = collectStarredMirrorTiles([shortcut(makeTab({ sessionId: "old" }))]);
    const after = collectStarredMirrorTiles([shortcut(makeTab({ sessionId: "new" }))]);
    expect(before[0].key).not.toBe(after[0].key);
  });

  it("flattens split-terminal tabs into one tile per leaf", () => {
    const rootPane: TerminalPaneNode = {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "leaf", id: "leaf-a", sessionId: "sess-a" },
        { type: "leaf", id: "leaf-b", sessionId: null },
      ],
    } as TerminalPaneNode;
    const tiles = collectStarredMirrorTiles([
      shortcut(makeTab({ terminalRootPane: rootPane })),
    ]);

    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ sessionId: "sess-a", key: "tab-1:leaf-a:sess-a" });
    // 未启动的 leaf 出占位（sessionId null）
    expect(tiles[1]).toMatchObject({ sessionId: null, key: "tab-1:leaf-b:pending" });
  });

  it("renders non-terminal starred tabs as placeholder tiles", () => {
    const tiles = collectStarredMirrorTiles([
      shortcut(makeTab({ contentType: "editor", sessionId: "irrelevant" })),
    ]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].sessionId).toBeNull();
  });
});

describe("mirrorGridClass", () => {
  it("scales layout with tile count", () => {
    expect(mirrorGridClass(1)).toBe("grid-cols-1");
    expect(mirrorGridClass(2)).toBe("grid-cols-2");
    expect(mirrorGridClass(3)).toBe("grid-cols-2 grid-rows-2");
    expect(mirrorGridClass(4)).toBe("grid-cols-2 grid-rows-2");
    expect(mirrorGridClass(5)).toContain("auto-rows-");
  });
});
