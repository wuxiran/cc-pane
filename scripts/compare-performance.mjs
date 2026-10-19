import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 跨版本性能回归比较器（docs/105 F6.1 / F6.4）。
//
// 背景：summarize-performance.mjs 已能把一次 soak 的 performance.jsonl 汇总成
// 一份报告，summarize-desktop-acceptance.mjs 也有桌面验收报告，但仓库里没有任何
// 把「旧构建报告」与「新构建报告」放在一起、按阈值判定回归/持平的工具——发版
// checklist 因此无法给出可重复的「不低于基线 90%」结论。本模块补这一块：纯函数、
// 可单测、退出码可作 CI 闸门。
//
// 口径：比较 summarizePerformance() 的报告形状（顶层 max* 指标 + 进程峰值内存聚合）。
// 所有指标一律「越低越好」（内存/积压/延迟）。新增指标只需扩 METRICS。

/**
 * 参与比较的指标。一律「越低越好」（内存/积压/延迟）；label 用于人类可读输出，
 * get 从报告里取数。get 返回 null/undefined 视为「本侧无数据」，比较时记为 na。
 */
function peakObservedProcessValue(report, field, roles) {
  const values = (Array.isArray(report.processes) ? report.processes : [])
    .filter(p => !roles || roles.includes(p.role))
    .map(p => toNumber(p[field])).filter(value => value != null);
  return values.length ? Math.max(...values) : null;
}

const METRICS = [
  { key: "maxHeapUsedBytes", label: "前端 JS 堆峰值 (bytes)", get: (r) => r.maxHeapUsedBytes },
  { key: "maxQueuedChars", label: "终端积压字符峰值", get: (r) => r.maxQueuedChars },
  { key: "maxFrontendAgeMs", label: "前端上报最大延迟 (ms)", get: (r) => r.maxFrontendAgeMs },
  { key: "maxTimerLagMs", label: "定时器最大延迟 (ms)", get: (r) => r.maxTimerLagMs },
  { key: "maxSamplingGapMs", label: "未观测间隔峰值 (ms，休眠或停顿)", get: r => r.maxSamplingGapMs },
  { key: "maxSampleDurationMs", label: "采样自身最大耗时 (ms)", get: (r) => r.maxSampleDurationMs },
  {
    key: "peakProcessPrivateBytes",
    label: "进程私有内存峰值 (bytes)",
    get: r => peakObservedProcessValue(r, "peakPrivateBytes"),
  },
  { key: "peakRendererResidentBytes", label: "渲染器常驻内存峰值 (bytes)",
    get: r => peakObservedProcessValue(r, "peakResidentBytes", ["renderer"]) },
];

/** 把数值收敛成「可比较的有限数」或 null。 */
function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Older samplers included suspension in timer lag. Preserve that conservative
// basis when comparing across versions instead of claiming a fake improvement.
function legacyCompatibleLag(report) {
  const lag = toNumber(report.maxTimerLagMs);
  const gap = toNumber(report.maxSamplingGapMs);
  return lag == null && gap == null ? null : Math.max(lag ?? 0, Math.max(0, (gap ?? 0) - 1000));
}

/**
 * 比较两份 summarizePerformance 报告。
 *
 * @param {object} baseline 旧构建（基线）报告
 * @param {object} candidate 新构建（候选）报告
 * @param {{ tolerance?: number }} [options] tolerance 为允许的劣化比例，默认 0.1
 *   （即「不低于基线 90%」：候选超过基线 10% 以上判回归）。
 * @returns {{
 *   ok: boolean,
 *   tolerance: number,
 *   rows: Array<{ key: string, label: string, baseline: number|null,
 *     candidate: number|null, deltaRatio: number|null, verdict:
 *     "regression"|"ok"|"improved"|"na" }>,
 *   regressions: string[],
 * }}
 */
export function compareReports(baseline, candidate, options = {}) {
  const tolerance = toNumber(options.tolerance) ?? 0.1;
  const base = baseline ?? {};
  const cand = candidate ?? {};
  const rows = [];
  const regressions = [];

  let metrics = toNumber(base.maxFrontendUpdateIntervalMs) != null && toNumber(cand.maxFrontendUpdateIntervalMs) != null
    ? METRICS.map(metric => metric.key === "maxFrontendAgeMs"
      ? { key: "maxFrontendUpdateIntervalMs", label: "前端更新最大间隔 (ms)", get: r => r.maxFrontendUpdateIntervalMs }
      : metric)
    : METRICS;
  if (toNumber(base.maxSamplingGapMs) == null || toNumber(cand.maxSamplingGapMs) == null) {
    metrics = metrics.map(metric => metric.key === "maxTimerLagMs"
      ? { ...metric, get: legacyCompatibleLag } : metric);
  }
  for (const metric of metrics) {
    const b = toNumber(metric.get(base));
    const c = toNumber(metric.get(cand));

    // Missing observations are null. Numeric zero is a measured baseline and
    // must not hide a newly introduced stall or queue.
    if (b == null || c == null) {
      rows.push({ key: metric.key, label: metric.label, baseline: b, candidate: c, deltaRatio: null, verdict: "na" });
      continue;
    }

    const deltaRatio = b === 0 ? null : (c - b) / b;
    let verdict;
    if (b === 0) verdict = c === 0 ? "ok" : "regression";
    else if (deltaRatio > tolerance) verdict = "regression";
    else if (deltaRatio < -tolerance) verdict = "improved";
    else verdict = "ok";

    rows.push({ key: metric.key, label: metric.label, baseline: b, candidate: c, deltaRatio, verdict });
    if (verdict === "regression") regressions.push(metric.key);
  }

  const comparableMetrics = rows.filter(row => row.verdict !== "na").length;
  return { ok: regressions.length === 0 && comparableMetrics > 0, tolerance, rows, regressions, comparableMetrics };
}

/** 把比较结果渲染成对齐的文本表（人类可读，CI 日志友好）。 */
export function formatComparison(result) {
  const pct = (ratio) => (ratio == null ? "    n/a" : `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`);
  const num = (n) => (n == null ? "n/a" : String(Math.round(n)));
  const lines = [];
  lines.push(`性能回归比较（容差 ±${(result.tolerance * 100).toFixed(0)}%，越低越好）`);
  lines.push("");
  for (const row of result.rows) {
    const flag =
      row.verdict === "regression" ? "✗ REGRESSION"
      : row.verdict === "improved" ? "✓ improved"
      : row.verdict === "na" ? "- n/a"
      : "= ok";
    lines.push(
      `  ${flag.padEnd(13)} ${row.label.padEnd(28)} ` +
      `baseline=${num(row.baseline).padStart(12)} candidate=${num(row.candidate).padStart(12)} ` +
      `delta=${pct(row.deltaRatio)}`,
    );
  }
  lines.push("");
  lines.push(
    result.comparableMetrics === 0
      ? "结论：没有可比较的数据，无法判断性能是否回归。"
      : result.ok
      ? `结论：已比较 ${result.comparableMetrics} 项，无回归；${result.rows.length - result.comparableMetrics} 项缺少可比较数据。`
      : `结论：检测到回归 → ${result.regressions.join(", ")}`,
  );
  return lines.join("\n");
}

async function readReport(path) {
  if (!path) throw new Error("missing report path");
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const baselinePath = valueOf("--baseline");
  const candidatePath = valueOf("--candidate");
  if (!baselinePath || !candidatePath) {
    throw new Error(
      "Usage: node scripts/compare-performance.mjs --baseline <report.json> --candidate <report.json> [--tolerance 0.1] [--json]",
    );
  }
  const toleranceArg = valueOf("--tolerance");
  const tolerance = toleranceArg != null ? Number(toleranceArg) : undefined;

  const baseline = await readReport(baselinePath);
  const candidate = await readReport(candidatePath);
  const result = compareReports(baseline, candidate, { tolerance });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatComparison(result));
  }
  // 退出码即闸门：回归 → 1。
  process.exitCode = result.ok ? 0 : 1;
}
