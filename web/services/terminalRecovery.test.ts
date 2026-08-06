// M3b-3：恢复读路径单入口——双模式 + 旧 daemon 回落形状 + noteEpoch 接通。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
  noteReceived,
  noteWritten,
} from "@/components/panes/terminalOutputSeqTracker";
import { isTauriRuntime } from "./runtime";
import type { TerminalRecoverySnapshot } from "@/types";
import { _resetRecoveryCapabilityForTest, getRecoverySnapshot } from "./terminalRecovery";

vi.mock("./runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime")>();
  return { ...actual, isTauriRuntime: vi.fn(() => true) };
});

const SNAPSHOT: TerminalRecoverySnapshot = {
  checkpoint: {
    checkpointEpoch: 3,
    anchorSeq: 40,
    snapshotAnsi: "PHOTO",
    bufferMode: "normal",
    cols: 80,
    rows: 24,
    checkpointedAtMs: 1,
  },
  delta: "DELTA",
  bufferMode: "normal",
  endSeq: 55,
  checkpointEpoch: 3,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  resetTauriInvoke();
  _resetRecoveryCapabilityForTest();
  _resetSeqTrackersForTest();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRecoverySnapshot（Tauri 模式）", () => {
  it("经 get_terminal_recovery_snapshot 命令读取并透传统一形状", async () => {
    mockTauriInvoke({ get_terminal_recovery_snapshot: SNAPSHOT });

    const result = await getRecoverySnapshot("s-1");

    expect(invoke).toHaveBeenCalledWith("get_terminal_recovery_snapshot", {
      sessionId: "s-1",
    });
    expect(result).toEqual(SNAPSHOT);
  });

  it("会话不存在返回 null 且不登记 epoch", async () => {
    mockTauriInvoke({ get_terminal_recovery_snapshot: null });

    await expect(getRecoverySnapshot("s-2")).resolves.toBeNull();
    noteReceived("s-2", 10);
    noteWritten("s-2", 10);
    expect(anchorCandidate("s-2")).toBeNull();
  });

  it("epoch≠0 时 noteEpoch 接通：seq 记账补上 epoch 后锚点候选可用（上传转活钥匙）", async () => {
    mockTauriInvoke({ get_terminal_recovery_snapshot: SNAPSHOT });

    await getRecoverySnapshot("s-3");
    noteReceived("s-3", 60);
    noteWritten("s-3", 60);

    expect(anchorCandidate("s-3")).toEqual({ anchorSeq: 60, checkpointEpoch: 3 });
  });

  it("epoch=0（旧 daemon 回落形状）不登记 epoch，上传保持 dormant", async () => {
    mockTauriInvoke({
      get_terminal_recovery_snapshot: {
        checkpoint: null,
        delta: "OLD",
        bufferMode: "normal",
        endSeq: 0,
        checkpointEpoch: 0,
      } satisfies TerminalRecoverySnapshot,
    });

    await getRecoverySnapshot("s-4");
    noteReceived("s-4", 10);
    noteWritten("s-4", 10);

    expect(anchorCandidate("s-4")).toBeNull();
  });
});

describe("getRecoverySnapshot（web 模式）", () => {
  beforeEach(() => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
  });

  it("GET /api/sessions/{id}/recovery-snapshot 返回统一形状", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRecoverySnapshot("s-web");

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-web/recovery-snapshot");
    expect(result).toEqual(SNAPSHOT);
  });

  it("结构化 NOT_FOUND（新 daemon、会话真没了）返回 null，不回落", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, { code: "NOT_FOUND", message: "session not found" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRecoverySnapshot("s-gone")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("旧 daemon 缺路由（无结构化 code 的 404）回落 /snapshot 包成 checkpoint: null 形状", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/recovery-snapshot")) {
        return new Response("Not Found", { status: 404 });
      }
      expect(url).toBe("/api/sessions/s-old/snapshot");
      return jsonResponse(200, { data: "LEGACY-VT", bufferMode: "alternate" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRecoverySnapshot("s-old");

    // 前端消费方只有一个形状：旧拼接快照被包成纯 delta + epoch=0
    expect(result).toEqual({
      checkpoint: null,
      delta: "LEGACY-VT",
      bufferMode: "alternate",
      endSeq: 0,
      checkpointEpoch: 0,
    });
  });

  it("capability 关断：首个缺路由后不再探测 recovery-snapshot 端点", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/recovery-snapshot")) {
        return new Response("Not Found", { status: 404 });
      }
      return jsonResponse(200, { data: "L", bufferMode: "normal" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getRecoverySnapshot("s-old");
    await getRecoverySnapshot("s-old");

    const probeCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/recovery-snapshot"),
    );
    expect(probeCalls).toHaveLength(1);
  });

  it("其他 HTTP 错误按错误上抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    await expect(getRecoverySnapshot("s-err")).rejects.toThrow("boom");
  });
});
