import { describe, expect, it } from "vitest";
import { buildTerminalExportFileName, serializeTerminalBuffer } from "./terminalBufferSnapshot";

function makeTerm(lines: Array<string | undefined>) {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number) =>
          lines[y] === undefined
            ? undefined
            : { translateToString: () => lines[y] as string },
      },
    },
  };
}

describe("serializeTerminalBuffer", () => {
  it("按行拼接活动缓冲区内容", () => {
    expect(serializeTerminalBuffer(makeTerm(["hello", "world"]))).toBe("hello\nworld");
  });

  it("裁掉末尾空行但保留中间空行", () => {
    expect(serializeTerminalBuffer(makeTerm(["a", "", "b", "", ""]))).toBe("a\n\nb");
  });

  it("空缓冲区返回空字符串", () => {
    expect(serializeTerminalBuffer(makeTerm([]))).toBe("");
    expect(serializeTerminalBuffer(makeTerm(["", ""]))).toBe("");
  });

  it("缺失的行按空行处理", () => {
    expect(serializeTerminalBuffer(makeTerm(["a", undefined, "b"]))).toBe("a\n\nb");
  });
});

describe("buildTerminalExportFileName", () => {
  const now = new Date(2026, 6, 18, 9, 5, 3);

  it("取项目目录名并附带时间戳", () => {
    expect(buildTerminalExportFileName("D:\\work\\my-proj", now)).toBe(
      "my-proj-terminal-20260718-090503.txt"
    );
    expect(buildTerminalExportFileName("/home/user/demo", now)).toBe(
      "demo-terminal-20260718-090503.txt"
    );
  });

  it("过滤文件名非法字符", () => {
    expect(buildTerminalExportFileName("/tmp/a b:c", now)).toBe(
      "a-b-c-terminal-20260718-090503.txt"
    );
  });

  it("空路径回退为 terminal", () => {
    expect(buildTerminalExportFileName("", now)).toBe("terminal-terminal-20260718-090503.txt");
  });
});
