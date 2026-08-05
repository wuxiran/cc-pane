import { beforeEach, describe, expect, it } from "vitest";
import { useEditorRevealStore } from "./useEditorRevealStore";

describe("useEditorRevealStore", () => {
  beforeEach(() => useEditorRevealStore.getState().resetForTest());

  it("stores one-shot requests by canonical file path", () => {
    const requestId = useEditorRevealStore.getState().request("C:/repo/src/App.tsx", 12, 8);

    expect(useEditorRevealStore.getState().requests["C:/repo/src/App.tsx"]).toEqual({
      requestId,
      filePath: "C:/repo/src/App.tsx",
      line: 12,
      column: 8,
    });
  });

  it("does not let an old acknowledge remove a newer request", () => {
    const first = useEditorRevealStore.getState().request("C:/repo/src/App.tsx", 12, 8);
    const second = useEditorRevealStore.getState().request("C:/repo/src/App.tsx", 30, 2);

    useEditorRevealStore.getState().acknowledge("C:/repo/src/App.tsx", first);
    expect(useEditorRevealStore.getState().requests["C:/repo/src/App.tsx"]?.requestId).toBe(second);

    useEditorRevealStore.getState().acknowledge("C:/repo/src/App.tsx", second);
    expect(useEditorRevealStore.getState().requests["C:/repo/src/App.tsx"]).toBeUndefined();
  });
});

