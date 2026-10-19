import { describe, expect, it } from "vitest";
import { parseFileLink, parseFileRef } from "./chatFileRefs";

describe("chat file reference safety", () => {
  it("opens POSIX absolute paths and line anchors", () => {
    expect(parseFileRef("/repo/src/main.rs:42")).toEqual({ path: "/repo/src/main.rs", line: 42 });
    expect(parseFileLink("/repo/src/main.rs#L42")).toEqual({ path: "/repo/src/main.rs", line: 42 });
  });
  it("decodes safe file URIs including Windows drives and UNC hosts", () => {
    expect(parseFileLink("file:///repo/a%20b.rs#L3")).toEqual({ path: "/repo/a b.rs", line: 3 });
    expect(parseFileLink("file:///C:/Work/a%23b.rs")).toEqual({ path: "C:/Work/a#b.rs" });
    expect(parseFileLink("file://server/share/a%25b.rs")).toEqual({ path: "//server/share/a%b.rs" });
  });
  it.each(["javascript:alert(1)", "data:text/html,evil", "https://example.test/file.rs", "#section", "file:///repo/a.rs?download=1"]) (
    "keeps non-local target %s as web/anchor instead of editor navigation", (target) => {
      expect(parseFileLink(target)).toBeNull();
    },
  );
  it("rejects malformed or unsafe local references", () => {
    expect(parseFileLink("file://user:pass@host/repo/a.rs")).toBeNull();
    expect(parseFileLink("/repo/a.rs?x=1")).toBeNull();
    expect(parseFileLink("/repo/a.rs#bad-anchor")).toBeNull();
  });
});
