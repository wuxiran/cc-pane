// 会话认领的身份核对（从 useTerminalSessionRestore 拆出的独立判据层）。
//
// 判错的代价不是重建一条会话，而是 **agent 在错误的仓库里继续对话**（不可逆）。
// 单列成模块有两个理由：判据本身是纯函数、值得独立测试与审阅；恢复流程那边只关心
// 「过没过、为什么没过」，不该被一百多行判据淹没。
import type {
  SavedSession,
  TerminalAdoptionSnapshot,
  TerminalSessionProvenance,
} from "@/types";
import { projectPathsEquivalent } from "@/utils/projectIdentity";

/**
 * 判据需要从当前窗格拿到的**全部**事实。
 *
 * 刻意只暴露这三项：`leaf` 是 UI 状态、部分字段靠现算，拿它做严格相等正是旧实现
 * 误杀的根源。窗格能提供的只有「项目路径」这一个可靠值，外加两项**正面证据**。
 */
export interface IdentityLeafFacts {
  projectPath: string;
  /** leaf 对 CLI 的正面证据；无从判断时 undefined（不回落到 "none"）。 */
  cliToolEvidence?: string;
  /** leaf 对运行环境的正面证据，只有 ssh / wsl；本地无从与「配置丢了」区分，故为 undefined。 */
  runtimeEvidence?: "ssh" | "wsl";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 身份核对的失败分类。`birth-anchor` 是**策略**而非身份，调用方需区别对待。 */
export type IdentityGate =
  | "generation"
  | "birth-anchor"
  | "anchor"
  | "project"
  | "runtime"
  | "resume";

export type IdentityVerdict =
  | { ok: true }
  | {
      ok: false;
      gate: IdentityGate;
      /** 具体是哪个字段没过，供日志直接展示 */
      field: string;
      /** 三方各自的值，避免再去翻 SQLite */
      values: { record?: string; provenance?: string; leaf?: string };
    };

function fail(
  gate: IdentityGate,
  field: string,
  values: { record?: string; provenance?: string; leaf?: string },
): IdentityVerdict {
  return { ok: false, gate, field, values };
}

/**
 * 三份数据对账：`record`（SQLite 可变观测行）/ `provenance`（daemon 不可变出生
 * 凭证）/ `leaf`（当前前端窗格）。
 *
 * **返回结构化结论而非 bool**：五段校验若共用一个 `false`，任何一条失败对外都
 * 只剩同一句话，排查时只能去翻库（这正是本函数被重写的直接原因）。
 *
 * 分层原则：`leaf` 是 UI 状态、部分字段靠现算，**只可用于锚点精确匹配**
 * （`anchorMatches` 已在做，那是 UUID 比对）；身份结论由 `record` ↔ `provenance`
 * ↔ `snapshot` 这些持久化事实给出，`leaf` 仅在**持有正面反证**时才否决。
 */
export function verifyIdentity(
  record: SavedSession,
  provenance: TerminalSessionProvenance,
  leaf: IdentityLeafFacts,
  snapshot: TerminalAdoptionSnapshot,
): IdentityVerdict {
  // —— 世代与出生随机数 ——
  // daemon 支持按指定 id 冷恢复，故 session_id 复用是设计内可能；靠世代号 +
  // 出生随机数证明「当前顶着这个 id 的 PTY」就是观测行写的那一个。
  if (snapshot.daemonGeneration === undefined) {
    return fail("generation", "snapshot.daemonGeneration", {});
  }
  if (record.daemonGeneration !== snapshot.daemonGeneration) {
    return fail("generation", "daemonGeneration", {
      record: String(record.daemonGeneration),
      leaf: String(snapshot.daemonGeneration),
    });
  }
  if (provenance.daemonGeneration !== snapshot.daemonGeneration) {
    return fail("generation", "daemonGeneration", {
      provenance: String(provenance.daemonGeneration),
      leaf: String(snapshot.daemonGeneration),
    });
  }
  if (!record.birthNonce || record.birthNonce !== provenance.birthNonce) {
    return fail("generation", "birthNonce", {
      record: record.birthNonce,
      provenance: provenance.birthNonce,
    });
  }
  if (provenance.sessionId !== record.sessionId) {
    return fail("generation", "sessionId", {
      record: record.sessionId,
      provenance: provenance.sessionId,
    });
  }

  // —— 当前锚点完整性 ——
  // 实际由 anchorMatches 保证（它做的是精确相等），这里是防御性重复。
  for (const [field, value] of [
    ["layoutId", record.layoutId],
    ["tabId", record.tabId],
    ["terminalPaneId", record.terminalPaneId],
  ] as const) {
    if (!value) return fail("anchor", field, { record: value ?? undefined });
  }

  // —— 出生锚点（策略，非身份）——
  // 只要求 tab + terminalPane：两者都是全局唯一 id，`terminalPaneId` 单独即可
  // 定位。**不要求 originLayoutId** —— layout 是唯一会合法移动的一维（跨布局
  // 拖动标签），它从不参与比对，查非空换不来任何身份保证。
  //
  // 缺这两个的会话是「无出生锚点」，按策略只能人工接管，调用方会给出与身份
  // 失败不同的原因码与出口。
  if (!nonEmpty(provenance.originTabId) || !nonEmpty(provenance.originTerminalPaneId)) {
    return fail("birth-anchor", "provenance.origin*", {
      provenance: `tab=${provenance.originTabId ?? "null"} pane=${provenance.originTerminalPaneId ?? "null"}`,
    });
  }

  // —— 项目路径 ——
  // 认领错会话意味着 agent 在错误的仓库里继续对话，不可逆。三方全查：
  // leaf.projectPath 源自 tab.projectPath，是存储值不是现算值，可靠。
  if (!record.projectPath || !provenance.projectPath || !leaf.projectPath) {
    return fail("project", "projectPath", {
      record: record.projectPath,
      provenance: provenance.projectPath,
      leaf: leaf.projectPath,
    });
  }
  if (!projectPathsEquivalent(record.projectPath, provenance.projectPath)) {
    return fail("project", "projectPath", {
      record: record.projectPath,
      provenance: provenance.projectPath,
    });
  }
  if (!projectPathsEquivalent(record.projectPath, leaf.projectPath)) {
    return fail("project", "projectPath", {
      record: record.projectPath,
      leaf: leaf.projectPath,
    });
  }

  // —— 运行环境与 CLI ——
  // record ↔ provenance 严格相等（都是持久化事实）。
  if (!record.runtimeKind || record.runtimeKind !== provenance.runtimeKind) {
    return fail("runtime", "runtimeKind", {
      record: record.runtimeKind,
      provenance: provenance.runtimeKind,
    });
  }
  if (record.cliTool !== provenance.cliTool) {
    return fail("runtime", "cliTool", {
      record: record.cliTool,
      provenance: provenance.cliTool,
    });
  }
  // leaf 侧只认正面反证：它明确是 ssh/wsl 却要去接一条别的运行环境的会话，拦；
  // 它什么都没带则视为未知而非 "local"——后者会把「布局快照丢了 wsl 配置」误判
  // 成身份不符（这正是旧实现最主要的误杀来源）。
  if (leaf.runtimeEvidence && leaf.runtimeEvidence !== record.runtimeKind) {
    return fail("runtime", "runtimeKind", {
      record: record.runtimeKind,
      leaf: leaf.runtimeEvidence,
    });
  }
  if (leaf.cliToolEvidence && leaf.cliToolEvidence !== record.cliTool) {
    return fail("runtime", "cliTool", {
      record: record.cliTool,
      leaf: leaf.cliToolEvidence,
    });
  }

  // —— resumeId ——
  // 只比 record ↔ provenance。leaf 侧的值会合法漂移（CLI 在 compaction 时轮换
  // session id），拿它投票会误杀；而「同 resumeId 命中多个活 PTY」本就是候选
  // 选择问题，已由 anchorMatches + ambiguous-candidates 覆盖。
  const resumeIds = new Set(
    [record.resumeId, provenance.resumeId]
      .map(nonEmpty)
      .filter((value): value is string => Boolean(value)),
  );
  if (resumeIds.size > 1) {
    return fail("resume", "resumeId", {
      record: record.resumeId,
      provenance: provenance.resumeId,
    });
  }
  return { ok: true };
}