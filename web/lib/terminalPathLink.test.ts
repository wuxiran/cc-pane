import { describe, expect, it, vi } from "vitest";
import {
  classifyOsc8TerminalLink,
  findTerminalPathLinks,
  parseTerminalPathReference,
  TerminalPathLinkProvider,
} from "./terminalPathLink";

const HOST_OPTIONS = { allowPosixAbsolute: true };

function createTerminal(
  lines: Array<{ text: string; isWrapped: boolean }>,
  columns = 80,
) {
  const makeLine = ({ text, isWrapped }: { text: string; isWrapped: boolean }) => {
    const cells: Array<{ chars: string; width: number }> = [];
    for (let index = 0; index < text.length;) {
      const point = text.codePointAt(index)!;
      const char = String.fromCodePoint(point);
      index += char.length;
      const next = text[index];
      const chars = next && /[\u0300-\u036f]/u.test(next) ? `${char}${next}` : char;
      if (chars.length > char.length) index += next.length;
      const wide = /[\u3400-\u9fff]|\p{Extended_Pictographic}/u.test(char);
      cells.push({ chars, width: wide ? 2 : 1 });
      if (wide) cells.push({ chars: "", width: 0 });
    }
    while (cells.length < columns) cells.push({ chars: "", width: 1 });
    return {
      isWrapped,
      length: cells.length,
      translateToString: () => text,
      getCell: (column: number, cell: { getChars(): string; getWidth(): number }) => {
        const current = cells[column] ?? { chars: "", width: 1 };
        cell.getChars = () => current.chars;
        cell.getWidth = () => current.width;
        return cell;
      },
    };
  };

  const bufferLines = lines.map(makeLine);
  return {
    cols: columns,
    buffer: {
      active: {
        length: bufferLines.length,
        getLine: (index: number) => bufferLines[index],
        getNullCell: () => ({ getChars: () => "", getWidth: () => 1 }),
      },
    },
  } as never;
}

describe("parseTerminalPathReference", () => {
  it.each([
    ["F:/repo/docs/report.md:17", { path: "F:/repo/docs/report.md", line: 17, column: undefined }],
    ["C:\\repo\\src\\main.rs:9:4", { path: "C:\\repo\\src\\main.rs", line: 9, column: 4 }],
    ["/Users/dev/repo/main.ts:5", { path: "/Users/dev/repo/main.ts", line: 5, column: undefined }],
    ["./docs/report.md", { path: "./docs/report.md", line: undefined, column: undefined }],
    ["../shared/report.md:2", { path: "../shared/report.md", line: 2, column: undefined }],
    ["src/App.tsx:12:8", { path: "src/App.tsx", line: 12, column: 8 }],
    ["src\\App.tsx", { path: "src\\App.tsx", line: undefined, column: undefined }],
    ["./docs/design notes.md:3", { path: "./docs/design notes.md", line: 3, column: undefined }],
    ["F:/repo/报告.md:4", { path: "F:/repo/报告.md", line: 4, column: undefined }],
    ["packages/a-b_c/file.test.ts", { path: "packages/a-b_c/file.test.ts", line: undefined, column: undefined }],
    ["/tmp/a.b", { path: "/tmp/a.b", line: undefined, column: undefined }],
    ["a/b/c:10000000:10000000", { path: "a/b/c", line: 10_000_000, column: 10_000_000 }],
  ])("parses supported path %s", (input, expected) => {
    expect(parseTerminalPathReference(input, HOST_OPTIONS)).toMatchObject(expected);
  });

  it.each([
    "",
    "plain-file.txt",
    "https://example.com/a.ts:1",
    "file:///F:/repo/a.ts",
    "javascript:alert(1)",
    "C:relative\\file.ts",
    "src/a.ts:0",
    "src/a.ts:-1",
    "src/a.ts:10000001",
    "src/a.ts\0",
    "src/\u202esecret.ts",
    "src/a.ts\nnext",
    "\nsrc/a.ts",
    "src/a.ts\t",
    "src/\u200bsecret.ts",
    "src/\u061csecret.ts",
    "src/\u200esecret.ts",
    "src/\u200fsecret.ts",
    "\\\\server\\share\\a.ts",
    "\\\\?\\C:\\repo\\a.ts",
    "C:\\repo\\a.ts:stream",
  ])("rejects unsupported path %s", (input) => {
    expect(parseTerminalPathReference(input, HOST_OPTIONS)).toBeNull();
  });

  it("rejects POSIX absolute paths when the host cannot resolve them", () => {
    expect(parseTerminalPathReference("/home/dev/repo/a.ts", { allowPosixAbsolute: false })).toBeNull();
  });

  it("rejects parser input beyond the inspection budget", () => {
    expect(parseTerminalPathReference(`src/${"a".repeat(2048)}`, HOST_OPTIONS)).toBeNull();
  });

  it("preserves punctuation that is part of a complete candidate", () => {
    expect(parseTerminalPathReference("src/file!.txt", HOST_OPTIONS)).toMatchObject({
      path: "src/file!.txt",
      text: "src/file!.txt",
    });
  });
});

describe("findTerminalPathLinks", () => {
  it("finds multiple paths without capturing HTTP links or fullwidth prose", () => {
    const text = "写入 F:/repo/报告.md:4，修改 src/App.tsx:12:8；详情 https://example.com/a.ts";
    expect(findTerminalPathLinks(text, HOST_OPTIONS).map((link) => link.text)).toEqual([
      "F:/repo/报告.md:4",
      "src/App.tsx:12:8",
    ]);
  });

  it("caps returned candidates at sixteen", () => {
    const text = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts:${index + 1}`).join(" ");
    expect(findTerminalPathLinks(text, HOST_OPTIONS)).toHaveLength(16);
  });

  it("keeps source order when the candidate limit is reached", () => {
    const text = [
      "src/first.ts",
      ...Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts:${index + 1}`),
    ].join(" ");

    const links = findTerminalPathLinks(text, HOST_OPTIONS);

    expect(links).toHaveLength(16);
    expect(links[0].text).toBe("src/first.ts");
  });

  it("does not merge prose, steal custom URI schemes, or truncate long tokens", () => {
    const prose = "first src/a.ts then x/f0.ts:1 custom:bad/path.ts:2";
    expect(findTerminalPathLinks(prose, HOST_OPTIONS).map((link) => link.text)).toEqual([
      "src/a.ts",
      "x/f0.ts:1",
    ]);

    const overlong = `src/${"a".repeat(2048)}.ts`;
    expect(findTerminalPathLinks(overlong, HOST_OPTIONS)).toEqual([]);
  });

  it("accepts spaces only when a complete candidate has a clear boundary", () => {
    const text = 'open "./docs/design notes.md" and ./docs/other notes.md:3';
    expect(findTerminalPathLinks(text, HOST_OPTIONS).map((link) => link.text)).toEqual([
      "./docs/design notes.md",
      "./docs/other notes.md:3",
    ]);
    expect(findTerminalPathLinks('open " ./docs/design notes.md "', HOST_OPTIONS)[0]).toMatchObject({
      text: "./docs/design notes.md",
      startIndex: 7,
    });
  });

  it("keeps filename punctuation inside a token but excludes sentence punctuation", () => {
    const text = "wrote src/file!.txt and src/file(name).ts;";
    expect(findTerminalPathLinks(text, HOST_OPTIONS).map((link) => link.text)).toEqual([
      "src/file!.txt",
      "src/file(name).ts",
    ]);
  });
});

describe("classifyOsc8TerminalLink", () => {
  it("classifies local file and external HTTP targets", () => {
    expect(classifyOsc8TerminalLink("file:///F:/repo/a.ts:3", HOST_OPTIONS)).toEqual({
      type: "local",
      reference: expect.objectContaining({ path: "F:/repo/a.ts", line: 3 }),
    });
    expect(classifyOsc8TerminalLink("https://example.com/docs", HOST_OPTIONS)).toEqual({
      type: "external",
      url: "https://example.com/docs",
    });
    expect(classifyOsc8TerminalLink("file://localhost/F:/repo/a.ts:3", HOST_OPTIONS)).toEqual({
      type: "local",
      reference: expect.objectContaining({ path: "F:/repo/a.ts", line: 3 }),
    });
    expect(classifyOsc8TerminalLink("file:///F:/repo/file%21", HOST_OPTIONS)).toEqual({
      type: "local",
      reference: expect.objectContaining({ path: "F:/repo/file!" }),
    });
  });

  it.each([
    "file://server/share/a.ts",
    "file:/F:/repo/a.ts",
    "file:F:/repo/a.ts",
    "file:///F:/repo/a.ts%0A",
    "file:///home/dev/a.ts",
    "mailto:test@example.com",
    "javascript:alert(1)",
  ])("rejects unsupported OSC 8 target %s on Windows", (uri) => {
    expect(classifyOsc8TerminalLink(uri, { allowPosixAbsolute: false })).toBeNull();
  });

  it("rejects bidi controls in external targets", () => {
    expect(classifyOsc8TerminalLink("https://example.com/\u202eabc", HOST_OPTIONS)).toBeNull();
    expect(classifyOsc8TerminalLink("https://example.com/\u200babc", HOST_OPTIONS)).toBeNull();
    expect(classifyOsc8TerminalLink("https://", HOST_OPTIONS)).toBeNull();
    expect(classifyOsc8TerminalLink(`https://example.com/${"a".repeat(2048)}`, HOST_OPTIONS)).toBeNull();
  });
});

describe("TerminalPathLinkProvider", () => {
  it("maps a soft-wrapped path across xterm rows", () => {
    const first = "Saved F:/repo/docs/";
    const terminal = createTerminal([
      { text: first, isWrapped: false },
      { text: "report.md:17", isWrapped: true },
    ], first.length);
    const activated = vi.fn();
    const provider = new TerminalPathLinkProvider(terminal, activated, HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe("F:/repo/docs/report.md:17");
    expect(links?.[0].range.start.y).toBe(1);
    expect(links?.[0].range.start.x).toBe(7);
    expect(links?.[0].range.end.y).toBe(2);
    expect(links?.[0].range.end.x).toBe(12);
    links?.[0].activate({} as MouseEvent, links[0].text);
    expect(activated).toHaveBeenCalledWith(expect.objectContaining({ path: "F:/repo/docs/report.md", line: 17 }));
  });

  it("uses xterm cell widths after CJK, emoji, and combining characters", () => {
    const terminal = createTerminal([
      { text: "中😀e\u0301 F:/repo/a.ts:3", isWrapped: false },
    ]);
    const provider = new TerminalPathLinkProvider(terminal, vi.fn(), HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links).toHaveLength(1);
    expect(links?.[0].range).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 20, y: 1 },
    });
  });

  it("does not trust stale wrapped flags after a short TUI row", () => {
    const terminal = createTerminal([
      { text: "Read src/App.tsx", isWrapped: false },
      { text: "─".repeat(30), isWrapped: true },
    ], 80);
    const provider = new TerminalPathLinkProvider(terminal, vi.fn(), HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links?.[0].text).toBe("src/App.tsx");
    expect(links?.[0].range.end.y).toBe(1);
  });

  it("bounds backward soft-wrap scanning", () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      text: index === 299 ? "src/App.tsx".padEnd(80, "x") : "x".repeat(80),
      isWrapped: index > 0,
    }));
    const terminal = createTerminal(rows, 80) as never as {
      buffer: { active: { getLine: (index: number) => unknown } };
    };
    const getLine = vi.spyOn(terminal.buffer.active, "getLine");
    const provider = new TerminalPathLinkProvider(terminal as never, vi.fn(), HOST_OPTIONS);

    provider.provideLinks(300, () => {});

    expect(getLine.mock.calls.length).toBeLessThan(100);
  });

  it("keeps the requested row inside a bounded wrapped window", () => {
    const rows = [
      ...Array.from({ length: 32 }, (_, index) => ({
        text: `${index}`.padEnd(63, "x") + " ",
        isWrapped: index > 0,
      })),
      { text: "src/App.tsx", isWrapped: true },
    ];
    const terminal = createTerminal(rows, 64);
    const provider = new TerminalPathLinkProvider(terminal, vi.fn(), HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(33, (provided) => { links = provided; });

    expect(links?.some((link) => link.text === "src/App.tsx")).toBe(true);
  });

  it("does not link a path token truncated by the scan budget", () => {
    const text = `src/${"a".repeat(3000)}.ts`;
    const terminal = createTerminal([{ text, isWrapped: false }], text.length);
    const provider = new TerminalPathLinkProvider(terminal, vi.fn(), HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links).toBeUndefined();
  });

  it("does not join explicit hard newlines", () => {
    const terminal = createTerminal([
      { text: "F:/repo/docs/", isWrapped: false },
      { text: "report.md:17", isWrapped: false },
    ], 80);
    const provider = new TerminalPathLinkProvider(terminal, vi.fn(), HOST_OPTIONS);
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links?.[0].text).not.toBe("F:/repo/docs/report.md:17");
    expect(links?.[0].range.end.y).toBe(1);
  });
});
