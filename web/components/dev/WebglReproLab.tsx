import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import {
  createTerminalRendererController,
  type TerminalRendererController,
  type TerminalRendererDiagnostics,
} from "@/components/panes/terminalRendererController";
import { captureGpuDiagnostics, type GpuDiagnostics } from "@/utils/gpuDiagnostics";
import { parseCast, type TerminalCast } from "@/utils/terminalCast";

/**
 * WebGL 花屏复现台（?mode=webgl-lab）。
 *
 * 目的：把**真实录下的**终端字节流同时回放进「WebGL」与「DOM」两路 xterm，用**人眼**
 * 对比是否花屏，并采集 GPU / WebView2 / xterm 环境指纹 + WebGL 图集实时诊断，用数据
 * 判断花屏是否与特定环境/内容量相关。这是**诊断工具**，不改动生产渲染策略。
 *
 * WebGL 路复用生产的 TerminalRendererController（含图集/context-loss 诊断），
 * 但默认**不跑**生产里的 atlas 自愈（那会掩盖花屏）；提供手动「清图集/重建」按钮单测自愈。
 */

const DEFAULT_FONT =
  '"Maple Mono NF CN", "Cascadia Code", "Sarasa Mono SC", "Microsoft YaHei", "Consolas", monospace';

type ReplayState = "idle" | "playing" | "paused" | "done";

interface TermHandle {
  term: Terminal;
  controller: TerminalRendererController;
  hostEl: HTMLDivElement;
}

function noopLogger() {
  /* 诊断台不需要把渲染器日志外发 */
}

function makeTerm(host: HTMLDivElement, font: string, fontSize: number, cols: number, rows: number): TermHandle {
  const term = new Terminal({
    cols,
    rows,
    fontFamily: font,
    fontSize,
    allowProposedApi: true,
    scrollback: 2000,
    theme: { background: "#0b0e14", foreground: "#d7dae0" },
  });
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";
  term.open(host);
  const controller = createTerminalRendererController({
    term,
    logger: noopLogger,
    onRendererChanged: () => {},
  });
  return { term, controller, hostEl: host };
}

/** 生成 N 个互不相同的 CJK 字形（撑爆字形图集，复现「用量触发」的花屏） */
function synthCjkStress(distinct: number, cols: number): string {
  const start = 0x4e00;
  const chunks: string[] = [];
  let col = 0;
  for (let i = 0; i < distinct; i++) {
    chunks.push(String.fromCodePoint(start + (i % 0x5000)));
    col += 2;
    if (col >= cols - 2) {
      chunks.push("\r\n");
      col = 0;
    }
  }
  return "\x1b[H\x1b[2J" + chunks.join("");
}

export default function WebglReproLab() {
  const webglHostRef = useRef<HTMLDivElement | null>(null);
  const domHostRef = useRef<HTMLDivElement | null>(null);
  const webglRef = useRef<TermHandle | null>(null);
  const domRef = useRef<TermHandle | null>(null);
  const replayAbortRef = useRef<{ aborted: boolean } | null>(null);
  const snapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [font, setFont] = useState(DEFAULT_FONT);
  const [fontSize, setFontSize] = useState(14);
  const [cols, setCols] = useState(120);
  const [rows, setRows] = useState(30);
  const [speed, setSpeed] = useState(4);
  const [replay, setReplay] = useState<ReplayState>("idle");
  const [progress, setProgress] = useState(0);
  const [cast, setCast] = useState<TerminalCast | null>(null);
  const [diag, setDiag] = useState<TerminalRendererDiagnostics | null>(null);
  const [snapInk, setSnapInk] = useState<number | null>(null);

  const gpu = useMemo<GpuDiagnostics>(() => captureGpuDiagnostics(Date.now()), []);

  // 建立两路终端（cols/rows/font/size 变化时重建）
  useEffect(() => {
    const wHost = webglHostRef.current;
    const dHost = domHostRef.current;
    if (!wHost || !dHost) return;

    const webgl = makeTerm(wHost, font, fontSize, cols, rows);
    webgl.controller.configure("webgl");
    const dom = makeTerm(dHost, font, fontSize, cols, rows);
    dom.controller.configure("dom");
    webglRef.current = webgl;
    domRef.current = dom;

    webgl.term.write("\x1b[1;36mWebGL 渲染器\x1b[0m — 载入 cast 回放或点「合成 CJK 压测」\r\n");
    dom.term.write("\x1b[1;33mDOM 渲染器（真值参照）\x1b[0m\r\n");

    const poll = setInterval(() => setDiag(webgl.controller.getDiagnostics()), 500);

    return () => {
      clearInterval(poll);
      replayAbortRef.current && (replayAbortRef.current.aborted = true);
      webgl.controller.dispose();
      dom.controller.dispose();
      webgl.term.dispose();
      dom.term.dispose();
      webglRef.current = null;
      domRef.current = null;
    };
  }, [font, fontSize, cols, rows]);

  const writeBoth = useCallback((s: string) => {
    webglRef.current?.term.write(s);
    domRef.current?.term.write(s);
  }, []);

  const stopReplay = useCallback(() => {
    if (replayAbortRef.current) replayAbortRef.current.aborted = true;
    setReplay("idle");
  }, []);

  const runReplay = useCallback(
    async (events: { d: number; s: string }[], burst: boolean) => {
      if (replayAbortRef.current) replayAbortRef.current.aborted = true;
      const token = { aborted: false };
      replayAbortRef.current = token;
      setReplay("playing");
      setProgress(0);
      const total = events.length;
      for (let i = 0; i < total; i++) {
        if (token.aborted) return;
        const ev = events[i];
        if (!burst && ev.d > 0) {
          await new Promise((r) => setTimeout(r, Math.min(ev.d / speed, 200)));
        } else if (i % 200 === 0) {
          // burst 模式也让出主线程，避免长任务卡死 UI
          await new Promise((r) => setTimeout(r, 0));
        }
        if (token.aborted) return;
        writeBoth(ev.s);
        if (i % 25 === 0) setProgress(Math.round(((i + 1) / total) * 100));
      }
      setProgress(100);
      setReplay("done");
    },
    [speed, writeBoth],
  );

  const onLoadCast = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseCast(text);
      setCast(parsed);
      if (parsed.cols) setCols(parsed.cols);
      if (parsed.rows) setRows(parsed.rows);
    } catch (e) {
      alert(`cast 解析失败: ${String(e)}`);
    }
  }, []);

  const snapshotWebgl = useCallback(() => {
    const host = webglRef.current?.hostEl;
    if (!host) return;
    const canvases = Array.from(host.querySelectorAll("canvas"));
    if (canvases.length === 0) {
      setSnapInk(null);
      alert("未找到 WebGL 画布（可能已回退 DOM）");
      return;
    }
    // 取最大的一块画布（WebGL 渲染层）
    const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const out = snapCanvasRef.current;
    if (!out) return;
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    try {
      // 注意：WebGL 画布默认不保留 drawingBuffer，某些 WebView 上 drawImage 可能读到空白；
      // 读到空白不代表真花屏——此时以人眼对比为准。
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, out.width, out.height);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        // 背景 #0b0e14 ≈ (11,14,20)，明显偏离即视为“有墨”
        if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) ink++;
      }
      setSnapInk(ink / (out.width * out.height));
    } catch (e) {
      setSnapInk(null);
      alert(`画布读回失败（WebView 限制，属预期）: ${String(e)}`);
    }
  }, []);

  const buildReport = useCallback(() => {
    return {
      gpu,
      rendererDiagnostics: diag,
      snapshotInkRatio: snapInk,
      cast: cast
        ? { sessionId: cast.sessionId, events: cast.events.length, meta: cast.meta }
        : null,
      lab: { font, fontSize, cols, rows, speed },
      generatedAt: new Date().toISOString(),
    };
  }, [gpu, diag, snapInk, cast, font, fontSize, cols, rows, speed]);

  const exportReport = useCallback(() => {
    const blob = new Blob([JSON.stringify(buildReport(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `webgl-repro-report-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [buildReport]);

  return (
    <div style={S.page}>
      <div style={S.header}>
        <strong>WebGL 花屏复现台</strong>
        <span style={S.sub}>录制回放 · GPU/WebView2 采集 · 图集诊断（人眼判花，工具只辅助）</span>
        <div style={{ flex: 1 }} />
        <button style={S.btn} onClick={() => (window.location.href = window.location.pathname)}>
          ← 返回应用
        </button>
      </div>

      <div style={S.body}>
        {/* 左：环境 + 诊断 */}
        <div style={S.side}>
          <Section title="环境指纹（GPU / WebView2 / xterm）">
            <Kv k="平台" v={gpu.platform} />
            <Kv k="WebGL2" v={String(gpu.webgl2Supported)} />
            <Kv k="Vendor" v={gpu.unmaskedVendor} />
            <Kv k="Renderer" v={gpu.unmaskedRenderer} />
            <Kv k="ANGLE 后端" v={gpu.angleBackend} />
            <Kv k="MAX_TEXTURE_SIZE" v={gpu.maxTextureSize} />
            <Kv k="Chromium" v={gpu.chromiumVersion} />
            <Kv k="WebView2(Edg)" v={gpu.webview2Version} />
            <Kv k="devicePixelRatio" v={gpu.devicePixelRatio} />
            <Kv k="xterm / webgl-addon" v={`${gpu.xtermVersion} / ${gpu.webglAddonVersion}`} />
          </Section>

          <Section title="WebGL 图集实时诊断">
            <Kv k="活动渲染器" v={diag?.activeRenderer} />
            <Kv k="决策原因" v={diag?.decisionReason} />
            <Kv k="atlas 变更次数" v={diag?.atlasChangeCount} />
            <Kv k="atlas 画布数" v={diag?.atlasCanvasCount} />
            <Kv k="context 丢失次数" v={diag?.contextLossCount} />
            <Kv k="atlas 清理次数" v={diag?.atlasClearCount} />
            <Kv k="webgl 重建次数" v={diag?.webglRecreateCount} />
            <Kv k="快照 ink 占比" v={snapInk == null ? null : `${(snapInk * 100).toFixed(1)}%`} />
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <button style={S.btn} onClick={() => webglRef.current?.controller.clearTextureAtlas("lab")}>
                清图集
              </button>
              <button style={S.btn} onClick={() => webglRef.current?.controller.recreateWebgl("lab")}>
                重建 WebGL
              </button>
              <button style={S.btn} onClick={snapshotWebgl}>
                快照读回
              </button>
              <button style={S.btn} onClick={exportReport}>
                导出报告
              </button>
            </div>
            <canvas ref={snapCanvasRef} style={S.snap} />
          </Section>
        </div>

        {/* 右：控制 + 双终端 */}
        <div style={S.main}>
          <Section title="回放控制">
            <div style={S.controls}>
              <label style={S.field}>
                字体
                <input style={S.input} value={font} onChange={(e) => setFont(e.target.value)} />
              </label>
              <label style={S.field}>
                字号
                <input
                  style={S.inputSm}
                  type="number"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value) || 14)}
                />
              </label>
              <label style={S.field}>
                cols
                <input style={S.inputSm} type="number" value={cols} onChange={(e) => setCols(Number(e.target.value) || 120)} />
              </label>
              <label style={S.field}>
                rows
                <input style={S.inputSm} type="number" value={rows} onChange={(e) => setRows(Number(e.target.value) || 30)} />
              </label>
              <label style={S.field}>
                速度x
                <input style={S.inputSm} type="number" value={speed} onChange={(e) => setSpeed(Number(e.target.value) || 1)} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={S.btn}>
                载入 cast
                <input
                  type="file"
                  accept=".json,.cast.json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => e.target.files?.[0] && onLoadCast(e.target.files[0])}
                />
              </label>
              <button
                style={S.btnPrimary}
                disabled={!cast || replay === "playing"}
                onClick={() => cast && runReplay(cast.events, false)}
              >
                回放{cast ? `(${cast.events.length})` : ""}
              </button>
              <button
                style={S.btn}
                disabled={!cast || replay === "playing"}
                onClick={() => cast && runReplay(cast.events, true)}
              >
                极速回放(burst)
              </button>
              <button
                style={S.btn}
                disabled={replay === "playing"}
                onClick={() => runReplay([{ d: 0, s: synthCjkStress(3000, cols) }], true)}
              >
                合成 CJK 压测(3000 字形)
              </button>
              <button style={S.btn} disabled={replay !== "playing"} onClick={stopReplay}>
                停止
              </button>
              <span style={S.sub}>
                {replay} {progress}%
              </span>
            </div>
            <div style={S.hint}>
              录制：在正常应用里按 <b>Ctrl+Alt+Shift+R</b> 开/停录制活动终端（停时自动下载 cast）；
              打开本台：<b>Ctrl+Alt+Shift+G</b>。用真实 Claude 会话录的 cast 回放最能复现。
            </div>
          </Section>

          <div style={S.termsRow}>
            <div style={S.termCol}>
              <div style={S.termLabel}>WebGL</div>
              <div ref={webglHostRef} style={S.termHost} />
            </div>
            <div style={S.termCol}>
              <div style={S.termLabel}>DOM（真值参照）</div>
              <div ref={domHostRef} style={S.termHost} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={S.kv}>
      <span style={S.kvK}>{k}</span>
      <span style={S.kvV}>{v == null || v === "" ? "—" : String(v)}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#0b0e14", color: "#d7dae0", font: "13px/1.5 system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid #1c2230" },
  sub: { color: "#7c8698", fontSize: 12 },
  body: { flex: 1, display: "flex", minHeight: 0 },
  side: { width: 340, overflowY: "auto", borderRight: "1px solid #1c2230", padding: 12 },
  main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, padding: 12, gap: 10 },
  section: { marginBottom: 14, background: "#0f1420", border: "1px solid #1c2230", borderRadius: 8, padding: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: "#9aa4b6", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 },
  kv: { display: "flex", gap: 8, padding: "2px 0", fontSize: 12, alignItems: "baseline" },
  kvK: { color: "#7c8698", minWidth: 130, flexShrink: 0 },
  kvV: { color: "#d7dae0", wordBreak: "break-all", fontFamily: "monospace" },
  controls: { display: "flex", gap: 8, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "#7c8698" },
  input: { background: "#0b0e14", border: "1px solid #263041", color: "#d7dae0", borderRadius: 5, padding: "4px 6px", width: 260, fontFamily: "monospace", fontSize: 11 },
  inputSm: { background: "#0b0e14", border: "1px solid #263041", color: "#d7dae0", borderRadius: 5, padding: "4px 6px", width: 64, fontFamily: "monospace", fontSize: 11 },
  btn: { background: "#1a2130", border: "1px solid #2b3547", color: "#d7dae0", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
  btnPrimary: { background: "#2563eb", border: "1px solid #2563eb", color: "#fff", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" },
  hint: { marginTop: 8, fontSize: 11, color: "#7c8698", lineHeight: 1.6 },
  termsRow: { flex: 1, display: "flex", gap: 10, minHeight: 0 },
  termCol: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  termLabel: { fontSize: 11, color: "#9aa4b6", marginBottom: 4 },
  termHost: { flex: 1, background: "#0b0e14", border: "1px solid #1c2230", borderRadius: 6, overflow: "hidden", minHeight: 0 },
  snap: { width: "100%", marginTop: 8, border: "1px solid #1c2230", borderRadius: 4, background: "#000", imageRendering: "pixelated" },
};
