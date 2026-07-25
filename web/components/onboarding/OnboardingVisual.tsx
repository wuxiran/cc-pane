import { Boxes, Folder, GitBranch, PanelRight, TerminalSquare, Workflow } from "lucide-react";

const TERMINAL_LINES = ["$ claude", "Analyzing project...", "$ codex", "Reviewing changes..."];

function TerminalPair() {
  return (
    <div className="grid w-full grid-cols-2 gap-3 px-6">
      {[0, 1].map((column) => (
        <div key={column} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[var(--app-status-danger)]" />
            <span className="size-2 rounded-full bg-[var(--app-status-warning)]" />
            <span className="size-2 rounded-full bg-[var(--app-status-success)]" />
          </div>
          {TERMINAL_LINES.slice(column * 2, column * 2 + 2).map((line, index) => (
            <div
              key={line}
              className="onboarding-demo-terminal-line mb-2 h-2 rounded-sm bg-[var(--app-text-tertiary)]"
              style={{ width: index === 0 ? "58%" : "84%" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function StepVisual({ step }: { step: number }) {
  switch (step) {
    case 0:
      return (
        <div className="space-y-3 px-10">
          {["Claude", "Codex", "Git", "WSL"].map((item, index) => (
            <div key={item} className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] px-4 py-3 shadow-sm">
              <span className="onboarding-demo-scan size-3 rounded-full bg-[var(--app-status-success)]" style={{ animationDelay: `${index * 120}ms` }} />
              <span className="text-xs font-medium text-[var(--app-text-secondary)]">{item}</span>
            </div>
          ))}
        </div>
      );
    case 1:
      return (
        <div className="grid grid-cols-2 gap-3 px-8">
          {[TerminalSquare, Folder, Workflow, Boxes].map((Icon, index) => (
            <div key={index} className="onboarding-demo-module flex aspect-square items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] shadow-sm">
              <Icon className="size-6 text-[var(--app-accent)]" />
            </div>
          ))}
        </div>
      );
    case 2:
      return (
        <div className="relative mx-auto w-64 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-text-primary)]">
            <Folder className="size-4 text-[var(--app-accent)]" /> Workspace
          </div>
          <div className="ml-2 mt-4 space-y-3 border-l border-[var(--app-border)] pl-5">
            {["frontend", "backend", "research-notes"].map((name, index) => (
              <div key={name} className="onboarding-demo-tree flex items-center gap-2 text-xs text-[var(--app-text-secondary)]" style={{ animationDelay: `${index * 140}ms` }}>
                {index < 2 ? <GitBranch className="size-3.5" /> : <Folder className="size-3.5" />}
                {name}
              </div>
            ))}
          </div>
        </div>
      );
    case 3:
      return <TerminalPair />;
    default:
      return (
        <div className="mx-6 flex h-60 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] shadow-sm">
          <div className="w-16 border-r border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
            <Folder className="mb-4 size-4 text-[var(--app-accent)]" />
            <GitBranch className="size-4 text-[var(--app-text-tertiary)]" />
          </div>
          <div className="flex-1 p-4"><TerminalPair /></div>
          <div className="onboarding-demo-dock w-20 border-l border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
            <PanelRight className="size-4 text-[var(--app-accent)]" />
          </div>
        </div>
      );
  }
}

export default function OnboardingVisual({ step }: { step: number }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden">
      <div className="w-full"><StepVisual step={step} /></div>
      <svg className="pointer-events-none absolute inset-0 size-full opacity-20" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M8 82 C 30 58, 62 96, 92 24" fill="none" stroke="var(--app-accent)" strokeWidth="0.6" strokeDasharray="2 3" />
      </svg>
    </div>
  );
}
