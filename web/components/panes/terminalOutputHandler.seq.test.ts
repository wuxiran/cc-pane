// M3b-2：输出写入管线的 seq 记账接线——onWritten 记 written、隐藏积压保守失效。
// noteReceived 在 service 分发单点发生（见 terminalService.test），这里手动补喂。
import { beforeEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalOutputHandler } from "./terminalOutputHandler";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
  noteReceived,
  reanchorSeq,
} from "./terminalOutputSeqTracker";

const fakeTerm = { buffer: { active: { type: "normal" } } } as unknown as Terminal;

function makeHandler(options: { visible: boolean; term?: Terminal | null }): {
  handler: (data: string, endSeq?: number) => void;
  writes: string[];
} {
  const writes: string[] = [];
  const hiddenWriteBufferRef: { current: TerminalHiddenWriteBuffer | null } = { current: null };
  const handler = createTerminalOutputHandler({
    sessionId: "s1",
    terminalRef: { current: options.term === undefined ? fakeTerm : options.term },
    focusReportModeRef: { current: false },
    hiddenWriteBufferRef,
    isRenderVisible: () => options.visible,
    keepCliOutputInNormalBuffer: false,
    renderTerminalData: (data) => data,
    // 同步回调 onWritten：模拟 xterm 确认解析
    writeTerminalData: (data, onWritten) => {
      writes.push(data);
      onWritten?.();
      return Promise.resolve();
    },
    syncTrackedBufferType: () => {},
    debugLog: () => {},
  });
  return { handler, writes };
}

beforeEach(() => {
  _resetSeqTrackersForTest();
});

describe("createTerminalOutputHandler 的 seq 记账", () => {
  it("可见直写路径：onWritten 后 received == written，锚点候选闭合", () => {
    reanchorSeq("s1", 0, 7);
    noteReceived("s1", 10);
    const { handler, writes } = makeHandler({ visible: true });

    handler("hello", 10);

    expect(writes).toEqual(["hello"]);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 10, checkpointEpoch: 7 });
  });

  it("chunk 进隐藏积压 → 保守失效（禁拍直到统一恢复 reanchor）", () => {
    reanchorSeq("s1", 0, 7);
    noteReceived("s1", 10);
    const { handler, writes } = makeHandler({ visible: false });

    handler("hidden-data", 10);

    expect(writes).toEqual([]);
    expect(anchorCandidate("s1")).toBeNull();
  });

  it("xterm 不在（数据被丢弃）→ 失效", () => {
    reanchorSeq("s1", 0, 7);
    noteReceived("s1", 10);
    const { handler } = makeHandler({ visible: true, term: null });

    handler("dropped", 10);

    expect(anchorCandidate("s1")).toBeNull();
  });

  it("渲染为空的 chunk 视同写完（否则尾空 chunk 让 in-flight 永不闭合）", () => {
    reanchorSeq("s1", 0, 7);
    noteReceived("s1", 10);
    const { handler, writes } = makeHandler({ visible: true });

    handler("", 10);

    expect(writes).toEqual([]);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 10, checkpointEpoch: 7 });
  });
});
