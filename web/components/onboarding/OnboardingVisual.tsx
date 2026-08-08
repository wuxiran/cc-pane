// 首启向导右栏视觉（四步制，纯 CSS/SVG，aria-hidden 由 GuidedDialog 的 aside 承担）：
// 0 预检扫描（CLI 身份色点）→ 1 材料收束进工作空间 → 2 双终端逐行打入 → 3 就绪工作台缩影。
// 背景叠低饱和 accent 渐变随步微移。
import { FileText, Folder, GitBranch, PanelRight, PenLine } from "lucide-react";

const BACKDROPS = [
  "radial-gradient(420px 300px at 80% 12%, var(--app-active-bg), transparent 70%)",
  "radial-gradient(420px 300px at 20% 88%, var(--app-active-bg), transparent 70%)",
  "radial-gradient(420px 300px at 82% 84%, var(--app-active-bg), transparent 70%)",
  "radial-gradient(460px 340px at 50% 10%, var(--app-active-bg), transparent 72%)",
];

function PreflightVisual() {
  const rows = [
    { color: "var(--app-cli-claude)", width: "40%" },
    { color: "var(--app-cli-codex)", width: "32%" },
    { color: "var(--app-text-tertiary)", width: "26%" },
    { color: "var(--app-status-warning)", width: "22%", pending: true },
  ];
  return (
    <div className="mx-auto flex w-full max-w-[280px] flex-col gap-2.5">
      {rows.map((row, index) => (
        <div
          key={index}
          className="tip-demo-rise flex items-center gap-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] px-3.5 py-2.5 shadow-sm"
          style={{ animationDelay: `calc(var(--dur-slow) * ${index})` }}
        >
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
          <span className="h-[7px] rounded-sm bg-[var(--app-hover)]" style={{ width: row.width }} />
          {row.pending ? (
            <span className="ml-auto text-[10px] text-[var(--app-status-warning)]">…</span>
          ) : (
            <svg className="ml-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--app-status-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkspaceVisual() {
  // 材料 chip 文字一律骨架条（视觉层 aria-hidden，信息在左栏文案）
  const chips = [
    { icon: GitBranch, width: 34, style: { left: "2%", top: 0 } },
    { icon: FileText, width: 44, style: { right: "4%", top: 6 } },
    { icon: PenLine, width: 40, style: { left: "30%", top: 26 } },
  ];
  return (
    <div className="relative mx-auto h-48 w-full max-w-[300px]">
      {chips.map((chip, index) => (
        <span
          key={index}
          className="tip-demo-rise absolute flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 py-1.5 shadow-sm"
          style={{ ...chip.style, animationDelay: `calc(var(--dur-slow) * ${index})` }}
        >
          <chip.icon className="size-[11px] text-[var(--app-text-secondary)]" aria-hidden="true" />
          <span className="block h-1.5 rounded-full bg-[var(--app-hover)]" style={{ width: chip.width }} />
        </span>
      ))}
      <div
        className="tip-demo-rise absolute inset-x-0 bottom-0 mx-auto w-56 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-4 shadow-sm"
        style={{ animationDelay: "calc(var(--dur-slow) * 2)" }}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--app-text-primary)]">
          <Folder className="size-3.5 text-[var(--app-accent)]" aria-hidden="true" /> Workspace
        </div>
        <div className="ml-1.5 mt-2.5 space-y-2 border-l border-[var(--app-border)] pl-4">
          {["frontend", "backend", "research-notes"].map((name, index) => (
            <div key={name} className="flex items-center gap-1.5 text-[11px] text-[var(--app-text-secondary)]">
              {index < 2 ? <GitBranch className="size-3" aria-hidden="true" /> : <Folder className="size-3" aria-hidden="true" />}
              {name}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TerminalPair({ typeIn = false }: { typeIn?: boolean }) {
  const terminals = [
    { color: "var(--app-cli-claude)", name: "claude", widths: ["46%", "82%", "68%", "74%"], offset: 0 },
    { color: "var(--app-cli-codex)", name: "codex", widths: ["38%", "76%", "58%", "80%"], offset: 0.5 },
  ];
  return (
    <div className="grid w-full grid-cols-2 gap-3 px-6">
      {terminals.map((terminal) => (
        <div key={terminal.name} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-3 shadow-sm">
          <div className="mb-2.5 flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: terminal.color }} />
            <span className="text-[10px] font-medium text-[var(--app-text-secondary)]">{terminal.name}</span>
          </div>
          {terminal.widths.map((width, index) => (
            <div
              key={index}
              className={typeIn ? "demo-type-in mb-1.5 h-1.5 rounded-sm" : "mb-1.5 h-1.5 rounded-sm"}
              style={{
                width,
                background: index === 0 ? "color-mix(in srgb, var(--app-accent) 45%, transparent)" : "var(--app-hover)",
                animationDelay: typeIn ? `calc(var(--dur-slow) * ${terminal.offset + index})` : undefined,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ReadyVisual() {
  return (
    <div className="tip-demo-rise mx-6 flex h-52 gap-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-3 shadow-sm">
      <div className="flex w-9 shrink-0 flex-col items-center gap-3 rounded-md bg-[var(--app-panel-bg)] py-3">
        <Folder className="size-3.5 text-[var(--app-accent)]" aria-hidden="true" />
        <GitBranch className="size-3.5 text-[var(--app-text-tertiary)]" aria-hidden="true" />
        <PanelRight className="size-3.5 text-[var(--app-text-tertiary)]" aria-hidden="true" />
      </div>
      {[
        { color: "var(--app-cli-claude)", widths: ["80%", "55%", "70%"] },
        { color: "var(--app-cli-codex)", widths: ["66%", "78%", "48%"] },
      ].map((terminal, column) => (
        <div key={column} className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-terminal-bg)] p-2.5">
          <span className="mb-2 block size-2 rounded-full" style={{ background: terminal.color }} />
          {terminal.widths.map((width, index) => (
            <span key={index} className="mb-1.5 block h-1.5 rounded-sm bg-[var(--app-hover)]" style={{ width }} />
          ))}
        </div>
      ))}
      <div className="flex w-14 shrink-0 flex-col gap-2 rounded-md bg-[var(--app-panel-bg)] p-2">
        {["90%", "70%", "80%"].map((width, index) => (
          <span
            key={index}
            className="tip-demo-slide-in block h-1.5 rounded-sm bg-[var(--app-hover)]"
            style={{ width, animationDelay: `calc(var(--dur-slow) * ${index})` }}
          />
        ))}
      </div>
    </div>
  );
}

export default function OnboardingVisual({ step }: { step: number }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 transition-[background] duration-[var(--dur-slow)]"
        style={{ background: BACKDROPS[Math.min(step, 3)] }}
      />
      <div className="relative w-full">
        {step === 0
          ? <PreflightVisual />
          : step === 1
            ? <WorkspaceVisual />
            : step === 2
              ? <TerminalPair typeIn />
              : <ReadyVisual />}
      </div>
    </div>
  );
}
