import { describe, expect, it } from "vitest";

const RAW_MODULES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALLOWED_LAYOUT_TRAVERSAL_FILES = {
  "components/LayoutSwitcherWindow.tsx": "renders a persisted layout snapshot list, not pane-tree traversal",
  "components/panes/DndPaneProvider.tsx": "looks up a DnD target layout by id",
  "components/panes/paneDndRouting.ts": "routes layout-tab DnD ordering",
  "hooks/useLayoutSwitcherSync.ts": "serializes layout switcher metadata",
  "stores/backendCloseActions.ts": "must include starred mirrors when backend kills a PTY",
  "stores/browserTabActions.ts": "legacy browser-tab lookup spans stored layout roots",
  "lib/paneTree.ts": "owns eachLayoutTreeWithStarred, the sanctioned starred-inclusive traversal for destroy paths",
  "stores/paneLayoutHelpers.ts": "owns the sanctioned layout traversal helpers",
  "stores/paneRemovalActions.ts": "handles leaf/layout removal paths that may include starred mirrors",
  "stores/panesPersistMigrations.ts": "migrates persisted layout arrays",
  "stores/usePanesStore.ts": "core layout owner; still being split under docs/78",
} as const;

const DIRECT_LAYOUT_TRAVERSAL_PATTERNS = [
  /\bfor\s*\([^)]*\bof\b[^)]*\.layouts\b/,
  /\.layouts\.(?:map|filter|find|findIndex|forEach|flatMap)\s*\(/,
] as const;

function relativePath(key: string): string {
  return key.replace(/^\.\.\//, "");
}

function isScannedFile(path: string): boolean {
  return !/\.test\./.test(path) && !path.startsWith("test/");
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function directTraversalLines(content: string): Array<{ line: number; text: string }> {
  return stripComments(content)
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => DIRECT_LAYOUT_TRAVERSAL_PATTERNS.some((pattern) => pattern.test(text)));
}

describe("layout traversal guard", () => {
  const entries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [relativePath(key), content] as const)
    .filter(([path]) => isScannedFile(path));

  it("keeps direct layouts iteration confined to documented owners", () => {
    const violations: string[] = [];
    const filesWithMatches = new Set<string>();

    for (const [path, content] of entries) {
      const matches = directTraversalLines(content);
      if (matches.length === 0) continue;
      filesWithMatches.add(path);
      if (path in ALLOWED_LAYOUT_TRAVERSAL_FILES) continue;
      for (const match of matches) {
        violations.push(`${path}:${match.line}: ${match.text.trim()}`);
      }
    }

    const staleAllowlist = Object.entries(ALLOWED_LAYOUT_TRAVERSAL_FILES)
      .filter(([path]) => !filesWithMatches.has(path))
      .map(([path, reason]) => `${path}: ${reason}`);

    expect(violations, `Use eachLayoutTree/layoutTree or document an exemption:\n${violations.join("\n")}`).toEqual([]);
    expect(staleAllowlist, `Remove stale layout traversal exemptions:\n${staleAllowlist.join("\n")}`).toEqual([]);
  });
});
