// identityMatches 失配矩阵（0.12.0 发版闸门 QA）。
//
// identityMatches 是「认领一条活 PTY」的最后一道闸：判错的代价不是重建一条会话，
// 而是 **agent 在错误的仓库里继续对话**（不可逆）。它有六组独立判据，此前只有
// 「全对」与「跨布局移动」两条正向用例——任何一组判据被误删都不会有测试变红。
//
// 本文件逐条钉死每一组，且区分「真判据」与「上游已挡」：
// - record.layoutId / record.tabId / record.terminalPaneId 为空 → **anchorMatches
//   先挡掉**（连候选都进不来），identityMatches 里那三条是纵深防御，无法从
//   reconcile 入口触达，故以候选零命中的方式记录其上游语义；
// - snapshot.daemonGeneration === undefined → 被 244 行的 complete 前置挡成
//   reconciliation-failed，同样不落到 identity-mismatch。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileTerminalSessions } from "./useTerminalSessionRestore";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { sessionRestoreService, terminalService } from "@/services";
import type { SavedSession, TerminalSessionProvenance } from "@/types";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useTerminalStatusStore: { getState: vi.fn() },
}));

vi.mock("@/services", () => ({
  terminalService: {
    createSession: vi.fn(),
    killSession: vi.fn(),
    getAdoptionSnapshot: vi.fn(),
    getDaemonClientInfo: vi.fn(),
    adoptSession: vi.fn(),
    releaseSession: vi.fn(),
  },
  sessionRestoreService: {
    load: vi.fn(),
    prune: vi.fn(),
  },
}));

vi.mock("@/components/panes/terminalRestoreQueue", () => ({
  terminalRestoreLaunchQueue: { run: (task: () => Promise<unknown>) => task() },
}));

vi.mock("@/services/runtime", () => ({ listenIfTauri: vi.fn() }));

const setTerminalRestoreBlocked = vi.fn();
const setSessionLeaseReadOnly = vi.fn();
const attachSessionToAnchor = vi.fn();
const replaceLiveStatuses = vi.fn();
const restoreLiveDaemonSessions = vi.fn();

/** 基线：一切对得上（Windows/WSL 两种形式的同一路径，等价而非字面相等）。 */
const BASE_PROVENANCE: TerminalSessionProvenance = {
  sessionId: "session-1",
  daemonGeneration: 42,
  birthNonce: "birth-1",
  originInstanceId: "app-a",
  originLayoutId: "layout-1",
  originTabId: "tab-1",
  originTerminalPaneId: "leaf-1",
  projectPath: "D:\\work\\project",
  runtimeKind: "local",
  cliTool: "claude",
  resumeId: "resume-1",
  createdAtMs: 1,
};

const BASE_SAVED: SavedSession = {
  sessionId: "session-1",
  tabId: "tab-1",
  paneId: "pane-1",
  terminalPaneId: "leaf-1",
  layoutId: "layout-1",
  projectPath: "D:\\work\\project",
  cliTool: "claude",
  runtimeKind: "local",
  resumeId: "resume-1",
  daemonGeneration: 42,
  birthNonce: "birth-1",
  originLayoutId: "layout-1",
  originTabId: "tab-1",
  originTerminalPaneId: "leaf-1",
  createdAt: "",
  savedAt: "",
  hasOutput: false,
} as SavedSession;

const BASE_LEAF = {
  type: "leaf",
  id: "leaf-1",
  sessionId: null,
  restoring: true,
  savedSessionId: "session-1",
  cliTool: "claude",
  resumeId: "resume-1",
};

const BASE_TAB = {
  id: "tab-1",
  contentType: "terminal",
  projectPath: "/mnt/d/work/project",
  cliTool: "claude",
};

interface RunOptions {
  record?: Partial<SavedSession>;
  provenance?: Partial<TerminalSessionProvenance>;
  leaf?: Record<string, unknown>;
  tab?: Record<string, unknown>;
}

async function run(options: RunOptions = {}) {
  const record = { ...BASE_SAVED, ...options.record } as SavedSession;
  const provenance = { ...BASE_PROVENANCE, ...options.provenance };
  const leaf = { ...BASE_LEAF, ...options.leaf };
  const tab = { ...BASE_TAB, ...options.tab, terminalRootPane: leaf };

  vi.mocked(usePanesStore.getState).mockReturnValue({
    getRestorableTabs: () => [{ layoutId: "layout-1", paneId: "pane-1", tab }],
    setTerminalRestoreBlocked,
    setSessionLeaseReadOnly,
    attachSessionToAnchor,
    restoreLiveDaemonSessions,
  } as never);
  vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue({
    claimsSupported: true,
    daemonGeneration: 42,
    ownerInstanceId: "app-b",
    capturedAtMs: 1,
    complete: true,
    sessions: [{ sessionId: "session-1", status: "idle", lastOutputAt: 1, updatedAt: 1 }],
    claims: {},
    provenance: { "session-1": provenance },
  } as never);
  vi.mocked(sessionRestoreService.load).mockResolvedValue([record] as never);

  return reconcileTerminalSessions({ autoAdopt: true });
}

/** 阻断时会连候选会话 id 一起记下，阻断面板据此提供手动接管出口。 */
function expectBlockedAs(
  report: { attached: number; blocked: number },
  reason: string,
  sessionId: string | undefined = "session-1",
): void {
  expect(setTerminalRestoreBlocked).toHaveBeenCalledWith("tab-1", "leaf-1", reason, sessionId);
  expect(report.attached).toBe(0);
  expect(report.blocked).toBe(1);
}

function expectMismatch(report: { attached: number; blocked: number }): void {
  expectBlockedAs(report, "identity-mismatch");
  expect(terminalService.adoptSession).not.toHaveBeenCalled();
}

function expectAccepted(report: { attached: number; blocked: number }): void {
  // 断言「没有任何阻断」而不是「没有某一种阻断」：前者才能挡住「换了个原因码
  // 继续误杀」这类回归。
  const blockingCalls = setTerminalRestoreBlocked.mock.calls.filter(
    (call) => call[2] !== undefined,
  );
  expect(blockingCalls).toEqual([]);
  expect(terminalService.adoptSession).toHaveBeenCalledWith("session-1");
  expect(report.attached).toBe(1);
  expect(report.blocked).toBe(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTerminalStatusStore.getState).mockReturnValue({ replaceLiveStatuses } as never);
  vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({ mode: "daemon" } as never);
  vi.mocked(terminalService.adoptSession).mockResolvedValue(true);
  vi.mocked(terminalService.releaseSession).mockResolvedValue(undefined);
  vi.mocked(sessionRestoreService.prune).mockResolvedValue(0);
  attachSessionToAnchor.mockReturnValue(true);
});

describe("identityMatches：基线", () => {
  it("六组判据全对时放行（projectPath 三方等价而非字面相等）", async () => {
    expectAccepted(await run());
  });
});

describe("identityMatches：daemonGeneration 三方一致", () => {
  it("record 缺 daemonGeneration → 失配", async () => {
    expectMismatch(await run({ record: { daemonGeneration: undefined } }));
  });

  it("record.daemonGeneration 与快照代不等 → 失配", async () => {
    expectMismatch(await run({ record: { daemonGeneration: 41 } }));
  });

  it("provenance.daemonGeneration 与快照代不等 → 失配（daemon 重启过）", async () => {
    expectMismatch(await run({ provenance: { daemonGeneration: 41 } }));
  });

  it("snapshot.daemonGeneration 缺失由 complete 前置挡成 reconciliation-failed（不落 identity）", async () => {
    vi.mocked(usePanesStore.getState).mockReturnValue({
      getRestorableTabs: () => [{
        layoutId: "layout-1",
        paneId: "pane-1",
        tab: { ...BASE_TAB, terminalRootPane: BASE_LEAF },
      }],
      setTerminalRestoreBlocked,
      setSessionLeaseReadOnly,
      attachSessionToAnchor,
      restoreLiveDaemonSessions,
    } as never);
    vi.mocked(terminalService.getAdoptionSnapshot).mockResolvedValue({
      claimsSupported: true,
      daemonGeneration: undefined,
      ownerInstanceId: "app-b",
      capturedAtMs: 1,
      complete: true,
      sessions: [{ sessionId: "session-1", status: "idle", lastOutputAt: 1, updatedAt: 1 }],
      claims: {},
      provenance: { "session-1": BASE_PROVENANCE },
    } as never);

    const report = await reconcileTerminalSessions({ autoAdopt: true });

    // 这条路径连候选都还没选出来，没有可供手动接管的会话 id。
    expect(setTerminalRestoreBlocked).toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "reconciliation-failed",
      undefined,
    );
    expect(report.blocked).toBe(1);
  });
});

describe("identityMatches：birthNonce", () => {
  it("record 缺 birthNonce → 失配（旧记录无出生证据，不得认领）", async () => {
    expectMismatch(await run({ record: { birthNonce: undefined } }));
  });

  it("record.birthNonce 为空串 → 失配", async () => {
    expectMismatch(await run({ record: { birthNonce: "" } }));
  });

  it("record 与 provenance 的 birthNonce 不等 → 失配（同锚点的另一条 PTY）", async () => {
    expectMismatch(await run({ provenance: { birthNonce: "birth-2" } }));
  });
});

describe("identityMatches：provenance.sessionId 自洽", () => {
  it("provenance.sessionId 与 record.sessionId 不等 → 失配（快照映射串位）", async () => {
    expectMismatch(await run({ provenance: { sessionId: "session-other" } }));
  });
});

describe("出生锚点：tab + terminalPane 必须有，layout 不作要求", () => {
  // 缺出生锚点是**策略**（该会话按设计只能人工接管），不是身份对不上。混报成
  // identity-mismatch 会让日志指向 CLI / 运行环境 / 项目路径这些实际完全正确的
  // 字段，把排查引向死路——这正是本轮返工的起因。
  const requiredFields = ["originTabId", "originTerminalPaneId"] as const;

  for (const field of requiredFields) {
    it(`provenance.${field} 缺失 → anchorless-session（非 identity-mismatch）`, async () => {
      expectBlockedAs(await run({ provenance: { [field]: undefined } }), "anchorless-session");
    });

    it(`provenance.${field} 为空串 → anchorless-session`, async () => {
      expectBlockedAs(await run({ provenance: { [field]: "" } }), "anchorless-session");
    });

    it(`provenance.${field} 为纯空白 → anchorless-session（trim 后为空，不得当作有值）`, async () => {
      expectBlockedAs(await run({ provenance: { [field]: "   " } }), "anchorless-session");
    });
  }

  // layout 是唯一会合法移动的一维（跨布局拖标签），它从不参与比对，查非空换不来
  // 任何身份保证；而后端派发会话时确实拿不到它（落点由前端五级链解析）。
  for (const empty of [undefined, "", "   "] as const) {
    it(`provenance.originLayoutId 为 ${JSON.stringify(empty)} → 放行`, async () => {
      expectAccepted(await run({ provenance: { originLayoutId: empty } }));
    });
  }

  it("MCP 派发的会话（有 tab/pane 锚点、无 layout）可自动接管", async () => {
    expectAccepted(await run({
      provenance: {
        originLayoutId: undefined,
        originTabId: "tab-minted-by-backend",
        originTerminalPaneId: "terminal-pane-minted-by-backend",
      },
    }));
  });

  it("出生锚点与当前锚点不同不算失配（跨布局移动合法）", async () => {
    expectAccepted(await run({
      provenance: {
        originLayoutId: "layout-old",
        originTabId: "tab-old",
        originTerminalPaneId: "leaf-old",
      },
    }));
  });

  it("record 的当前锚点为空由 anchorMatches 先挡（候选零命中，非 identity-mismatch）", async () => {
    const report = await run({ record: { layoutId: "" } });

    expect(setTerminalRestoreBlocked).not.toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "identity-mismatch",
    );
    // savedSessionId 仍活着但没有任何候选记录 → missing-provenance
    expect(setTerminalRestoreBlocked).toHaveBeenCalledWith(
      "tab-1",
      "leaf-1",
      "missing-provenance",
      "session-1",
    );
    expect(report.attached).toBe(0);
  });
});

describe("identityMatches：projectPath 三方等价", () => {
  it("record.projectPath 为空 → 失配", async () => {
    expectMismatch(await run({ record: { projectPath: "" } }));
  });

  it("provenance.projectPath 为空 → 失配", async () => {
    expectMismatch(await run({ provenance: { projectPath: "" } }));
  });

  it("leaf（tab）projectPath 为空 → 失配", async () => {
    expectMismatch(await run({ tab: { projectPath: "" } }));
  });

  it("record 与 provenance 的 projectPath 不等价 → 失配", async () => {
    expectMismatch(await run({ provenance: { projectPath: "D:\\work\\other" } }));
  });

  it("record 与 leaf 的 projectPath 不等价 → 失配（agent 会落在别的仓库）", async () => {
    expectMismatch(await run({ tab: { projectPath: "/mnt/d/work/other" } }));
  });

  it("WSL UNC 形式与 Windows 形式视为等价", async () => {
    expectAccepted(await run({ tab: { projectPath: "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\work\\project" } }));
  });
});

describe("runtimeKind / cliTool：record↔provenance 严格，leaf 只认正面反证", () => {
  // record 与 provenance 都是持久化事实，严格相等。
  it("record 缺 runtimeKind → 失配", async () => {
    expectMismatch(await run({ record: { runtimeKind: undefined } }));
  });

  it("record.runtimeKind 与 provenance 不等 → 失配", async () => {
    expectMismatch(await run({ provenance: { runtimeKind: "wsl" } }));
  });

  it("record.cliTool 与 provenance 不等 → 失配", async () => {
    expectMismatch(await run({ provenance: { cliTool: "codex" } }));
  });

  // leaf 带着明确的 ssh/wsl 配置去接一条别的运行环境的会话——这是真正危险的方向
  // （docs/61:63 记过一次事故：接管 WSL 会话后重建跑到本地错误目录），必须拦。
  it("leaf 明确带 wsl 配置而会话是 local → 失配", async () => {
    expectMismatch(await run({ leaf: { wsl: { distro: "Ubuntu", remotePath: "/mnt/d" } } }));
  });

  it("leaf 明确指定了另一个 cliTool → 失配", async () => {
    expectMismatch(await run({ leaf: { cliTool: "codex" }, tab: { cliTool: "codex" } }));
  });

  // 反方向不成立：leaf **没有**运行环境信息不等于「它是 local」。
  // resolveRuntimeKind 缺 ssh/wsl 时一律返回 "local"，旧实现拿这个兜底值做严格
  // 相等，于是「布局快照把 wsl 配置弄丢了」会被误判成身份不符——这是旧实现最
  // 主要的误杀来源。
  it("leaf 丢了 wsl 配置（会话本身是 wsl）→ 放行，不再误杀", async () => {
    expectAccepted(await run({
      record: { runtimeKind: "wsl" },
      provenance: { runtimeKind: "wsl" },
      leaf: { wsl: undefined },
      tab: { wsl: undefined },
    }));
  });

  it("leaf 丢了 cliTool（会话本身是 codex）→ 放行，不再误杀", async () => {
    expectAccepted(await run({
      record: { cliTool: "codex" },
      provenance: { cliTool: "codex" },
      leaf: { cliTool: undefined, launchClaude: undefined },
      tab: { cliTool: undefined },
    }));
  });
});

describe("resumeId：只比 record↔provenance（leaf 侧会合法漂移）", () => {
  it("record 与 provenance 不同 → 失配", async () => {
    expectMismatch(await run({
      record: { resumeId: "r-a" },
      provenance: { resumeId: "r-b" },
      leaf: { resumeId: "r-c" },
    }));
  });

  it("record 与 provenance 不同（leaf 缺失）→ 失配", async () => {
    expectMismatch(await run({
      record: { resumeId: "r-a" },
      provenance: { resumeId: "r-b" },
      leaf: { resumeId: undefined },
    }));
  });

  // CLI 会在 compaction 时轮换 session id，leaf 上的值因此可能与档案里的不同。
  // 旧实现把 leaf 也算作一票，于是正常轮换会被判成身份不符。
  it("leaf 的 resumeId 已轮换成另一个值 → 放行，不再误杀", async () => {
    expectAccepted(await run({
      record: { resumeId: "r-a" },
      provenance: { resumeId: "r-a" },
      leaf: { resumeId: "r-rotated" },
    }));
  });

  it("只有一方有值（size=1）→ 放行（另一方尚未回写 resumeId）", async () => {
    expectAccepted(await run({
      record: { resumeId: "r-a" },
      provenance: { resumeId: undefined },
      leaf: { resumeId: undefined },
    }));
  });

  it("三方全缺（size=0）→ 放行（裸 shell / 未发号）", async () => {
    expectAccepted(await run({
      record: { resumeId: undefined },
      provenance: { resumeId: undefined },
      leaf: { resumeId: undefined },
    }));
  });

  it("空白串被 nonEmpty 滤掉后视同缺失 → 放行", async () => {
    expectAccepted(await run({
      record: { resumeId: "  " },
      provenance: { resumeId: "resume-1" },
      leaf: { resumeId: "\t" },
    }));
  });

  it("身份通过但挂载被拒 → attach-rejected（不是身份问题，别再报成 identity-mismatch）", async () => {
    attachSessionToAnchor.mockReturnValue(false);

    const report = await run();

    expectBlockedAs(report, "attach-rejected");
    // 挂不上的会话必须把写权限还回去，否则它既没挂上又被本实例占着。
    expect(terminalService.releaseSession).toHaveBeenCalledWith("session-1");
  });

  it("同一 resumeId 带前后空白视为同值 → 放行", async () => {
    expectAccepted(await run({
      record: { resumeId: " resume-1 " },
      provenance: { resumeId: "resume-1" },
      leaf: { resumeId: "resume-1" },
    }));
  });
});
