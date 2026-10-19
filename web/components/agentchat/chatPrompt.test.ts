import { describe, expect, it } from "vitest";
import { buildPromptBlocks } from "./chatPrompt";

describe("agent prompt resource references", () => {
  it("resolves relative mentions against the actual project and preserves reserved filename characters", () => {
    const blocks = buildPromptBlocks("review @src/notes#v2.md and @/shared/a%20b.md", [
      { kind: "file", name: "data?draft.txt", path: "/project/data?draft.txt", mimeType: "text/plain", data: "" },
    ], "/project/CaseSensitive");
    const resources = blocks.filter((block) => block.type === "resource_link");
    expect(resources.map((block) => decodeURIComponent(new URL(block.uri as string).pathname))).toEqual([
      "/project/data?draft.txt", "/project/CaseSensitive/src/notes#v2.md", "/shared/a%20b.md",
    ]);
    expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: "review @src/notes#v2.md and @/shared/a%20b.md" });
  });

  it("keeps Windows absolute and relative mentions separate from UNC resources", () => {
    const blocks = buildPromptBlocks("@src/file.txt @D:\\other\\report#1.md", [
      { kind: "file", name: "network.txt", path: "\\\\server\\share\\a#b.txt", mimeType: "text/plain", data: "" },
    ], "C:\\Project");
    expect(blocks.filter((block) => block.type === "resource_link").map((block) => block.uri)).toEqual([
      "file://server/share/a%23b.txt", "file:///C:/Project/src/file.txt", "file:///D:/other/report%231.md",
    ]);
  });
});
