// killSession 调用点白名单守卫（0.12.0 发版闸门 QA）。
//
// 背景：docs/78 批1 把 5 份散落的 kill 实现收编进 destroyPipeline，CLAUDE.md 写着
// 「killSession 的调用点有白名单扫描测试守着，第 6 份实现在 CI 就会被拒」——
// 但那个测试并不存在。本文件补上它。
//
// 范式抄 test/layoutTraversalGuard.test.ts：扫全量源码（剥注释）+ 白名单必须写理由
// + 陈旧白名单反向检测（条目不再命中就必须删，否则白名单会变成一份没人敢动的历史）。
//
// 为什么要守：kill 是不可逆副作用，误杀 = 用户跑了几小时的 agent 会话直接消失。
// 新增一个调用点必须是**有意识的决定**，而不是「顺手在这儿也杀一下」。
import { describe, expect, it } from "vitest";

const RAW_MODULES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * 允许出现 `killSession(` 的文件 → 为什么它有资格杀。
 *
 * 逐条盘点（0.12.0 发版闸门时的现状，共 12 个文件 / 16 处）：
 * 每条都要能回答「谁在什么条件下杀、杀错了会怎样」。答不上来的应当改道
 * destroyPipeline，而不是加进这张表。
 */
const ALLOWED_KILL_SESSION_FILES = {
  // ── 服务层定义（唯一实现） ────────────────────────────────
  "services/terminalService.ts":
    "killSession 的唯一实现（invoke/REST 双模式），所有调用点最终落到这里",

  // ── 销毁管线（docs/78 批1 的收编出口） ────────────────────
  "lib/tabLifecycle/destroyPipeline.ts":
    "销毁管线阶段 2：关标签/删布局/快照覆盖的唯一杀点，按 DESTROY_POLICY.kills 与 DESTROY_KILL_REASON 分派",
  "stores/paneRemovalActions.ts":
    "关闭分屏单格（closeTerminalLeaf）：非整 tab 销毁，kill 与树操作同守卫——最后一格 no-op 时绝不杀",

  // ── 恢复/创建链路的回滚（杀的是本次刚建出来的重复 PTY） ────
  "components/panes/TerminalView.tsx":
    "创建竞态回滚：canCreateTerminalSession 复查失败或组件已卸载时杀掉本次刚建的 PTY；savedSessionId 相等即认领成功，不杀",
  "hooks/backgroundLayoutRestore.ts":
    "后台恢复的创建后复查回滚，与 TerminalView 同口径（sessionId !== expectedSavedSessionId 才杀）",
  "hooks/coldTerminalRestore.ts":
    "冷恢复（docs/81）：claims-unsupported 时用户显式确认的「杀旧建新」，杀的是已认领不了的旧 PTY",

  // ── 回收类（reason 落 orphan-reclaim，前端保留标签） ───────
  "hooks/useOrphanSessionReconciler.ts":
    "孤儿对账 GC：无任何引用且非活跃的会话，杀前有多实例守卫 + TOCTOU 复查",
  "stores/snapshotSessionDiff.ts":
    "snapshot-apply 差集真杀（默认关，settings.terminal.snapshotApplyKillEnabled），带单轮上限 10",
  "hooks/useSessionLayoutPersistence.ts":
    "把 terminalService.killSession 作为依赖注入给 performSnapshotApplyKills，本身不决定杀谁",

  // ── 用户显式操作 ──────────────────────────────────────────
  "components/statusbar/SystemResourceSegment.tsx":
    "资源管理器里用户按下「结束会话」（二次确认 armed 后），reason=user-close",
  "components/selfchat/SelfChatManager.tsx":
    "SelfChat 重启/结束会话：该会话不在 pane 树里（无 tabId），destroyPipeline 够不着，只能自管",
} as const;

/** 调用点计数上限：现状快照。新增调用点会顶破，逼着解释「为什么又多一处」。 */
const CALL_SITE_BUDGET: Record<string, number> = {
  "services/terminalService.ts": 1,
  "lib/tabLifecycle/destroyPipeline.ts": 1,
  "stores/paneRemovalActions.ts": 1,
  "components/panes/TerminalView.tsx": 4,
  "hooks/backgroundLayoutRestore.ts": 1,
  "hooks/coldTerminalRestore.ts": 1,
  "hooks/useOrphanSessionReconciler.ts": 1,
  "stores/snapshotSessionDiff.ts": 1,
  "hooks/useSessionLayoutPersistence.ts": 1,
  "components/statusbar/SystemResourceSegment.tsx": 2,
  "components/selfchat/SelfChatManager.tsx": 2,
};

const KILL_SESSION_PATTERN = /killSession\s*\(/g;

function relativePath(key: string): string {
  return key.replace(/^\.\.\//, "");
}

function isScannedFile(path: string): boolean {
  return !/\.test\./.test(path) && !path.startsWith("test/");
}

/**
 * 剥注释后再匹配：多个文件在注释里讨论 kill 语义（destroyPipeline 的矩阵说明、
 * paneSessions 的口径警告）。不剥的话守卫会把**规则的说明文字**判成调用点，
 * 逼人给纯文档开白名单——守卫一旦开始产生噪音就会被整体禁用。
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function killSessionLines(content: string): Array<{ line: number; text: string }> {
  return stripComments(content)
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      KILL_SESSION_PATTERN.lastIndex = 0;
      return KILL_SESSION_PATTERN.test(text);
    });
}

function countCallSites(content: string): number {
  return (stripComments(content).match(KILL_SESSION_PATTERN) ?? []).length;
}

describe("killSession 调用点白名单", () => {
  const entries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [relativePath(key), content] as const)
    .filter(([path]) => isScannedFile(path));

  it("扫描面非空且覆盖到已知调用点（防扫描器写坏后空转全绿）", () => {
    expect(entries.length).toBeGreaterThan(0);
    const hits = new Set(
      entries.filter(([, content]) => killSessionLines(content).length > 0).map(([path]) => path),
    );
    expect(hits).toContain("services/terminalService.ts");
    expect(hits).toContain("lib/tabLifecycle/destroyPipeline.ts");
  });

  it("kill 只能出现在白名单文件里（第 6 份散落实现在这里被拒）", () => {
    const violations: string[] = [];

    for (const [path, content] of entries) {
      if (path in ALLOWED_KILL_SESSION_FILES) continue;
      for (const match of killSessionLines(content)) {
        violations.push(`${path}:${match.line}: ${match.text.trim()}`);
      }
    }

    expect(
      violations,
      "新增 kill 调用点请改道 destroyPipeline；确有必要则加白名单并写清"
        + `「谁在什么条件下杀、杀错会怎样」:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("白名单不得陈旧（文件已不再 kill 就必须摘掉条目）", () => {
    const contentByPath = new Map(entries);
    const stale = Object.entries(ALLOWED_KILL_SESSION_FILES)
      .filter(([path]) => {
        const content = contentByPath.get(path);
        return !content || killSessionLines(content).length === 0;
      })
      .map(([path, reason]) => `${path}: ${reason}`);

    expect(stale, `移除陈旧的 kill 豁免:\n${stale.join("\n")}`).toEqual([]);
  });

  it("每条白名单都写了非空理由", () => {
    for (const [path, reason] of Object.entries(ALLOWED_KILL_SESSION_FILES)) {
      expect(reason.trim(), `${path} 缺理由`).not.toBe("");
    }
  });

  it("逐文件调用点数量不得增长（同一文件里悄悄多杀一处也要被看见）", () => {
    const violations: string[] = [];
    const contentByPath = new Map(entries);

    for (const [path, budget] of Object.entries(CALL_SITE_BUDGET)) {
      const content = contentByPath.get(path);
      if (!content) {
        violations.push(`${path}: 文件已不存在，请同步删除预算条目`);
        continue;
      }
      const actual = countCallSites(content);
      if (actual > budget) {
        violations.push(`${path}: 现有 ${actual} 处调用，预算 ${budget} 处`);
      }
      if (actual < budget) {
        violations.push(`${path}: 现有 ${actual} 处调用，预算 ${budget} 处——已减少，请下调预算`);
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("预算表与白名单键集一致（漏登记的文件不会被计数守着）", () => {
    expect(Object.keys(CALL_SITE_BUDGET).sort()).toEqual(
      Object.keys(ALLOWED_KILL_SESSION_FILES).sort(),
    );
  });
});
