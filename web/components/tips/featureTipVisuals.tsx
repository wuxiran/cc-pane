import type { CSSProperties, ReactNode } from "react";
import { THEME_SHAPES } from "@/theme/themeShapes";
import {
  AppWindow,
  ArrowRight,
  Bot,
  Check,
  Command,
  Files,
  GitBranch,
  Globe,
  LayoutGrid,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  Search,
  Slash,
  Sparkles,
  Terminal,
} from "lucide-react";

/**
 * tip 右栏演示。硬约束（docs/46 §6.1）：
 * 只用 CSS / HTML / 内联 SVG，零位图零网络素材；文字一律骨架条；
 * 动画走 `.tip-demo-*`（时长/缓动来自 `var(--dur*)`），reduced-motion 下呈现终态。
 * 整个右栏对读屏 aria-hidden，信息必须同时在左栏文案里可获得。
 */
export function VisualStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[180px] items-center justify-center p-6 text-[var(--app-text-secondary)]">
      {children}
    </div>
  );
}

const SKELETON = "rounded-full bg-[var(--app-hover)]";
const CARD = "rounded-lg border border-[var(--app-border)] bg-[var(--app-content)]";

function delay(steps: number): CSSProperties {
  return steps === 0 ? {} : { animationDelay: `calc(var(--dur-slow) * ${steps})` };
}

export function CommandPaletteVisual() {
  return (
    <VisualStage>
      <div className={`w-full max-w-[300px] overflow-hidden shadow-md ${CARD}`}>
        <div className="flex h-10 items-center gap-2 border-b border-[var(--app-border)] px-3 text-[var(--app-text-tertiary)]">
          <Search size={15} />
          <span className={`h-1.5 w-28 ${SKELETON}`} />
          <Command className="ml-auto text-[var(--app-accent)]" size={15} />
        </div>
        <div className="space-y-1.5 p-2">
          {["w-3/4", "w-2/3", "w-4/5"].map((width, index) => (
            <div
              key={width}
              className={`flex h-9 items-center gap-2 rounded-md px-2 ${index === 0 ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : ""}`}
            >
              <span className="size-5 rounded border border-[var(--app-border)]" />
              <span className={`h-1.5 ${width} ${SKELETON}`} />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

export function LayoutSwitcherVisual() {
  return (
    <VisualStage>
      <div className="flex w-full max-w-[320px] flex-col gap-3">
        <div className="grid h-32 grid-cols-[1fr_1.35fr] gap-1.5 rounded-lg border border-[var(--app-accent)] bg-[var(--app-content)] p-2 shadow-md">
          <span className="rounded-md bg-[var(--app-active-bg)]" />
          <span className="grid grid-rows-2 gap-1.5">
            <span className="rounded-md border border-[var(--app-border)]" />
            <span className="rounded-md border border-[var(--app-border)]" />
          </span>
        </div>
        <div className="flex justify-center gap-2">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={`flex size-9 items-center justify-center rounded-md border ${index === 0 ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "border-[var(--app-border)] bg-[var(--app-content)]"}`}
            >
              <LayoutGrid size={15} />
            </span>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

export function MiniModeVisual() {
  return (
    <VisualStage>
      <div className="flex items-center gap-4">
        <div className={`relative h-36 w-48 p-2 shadow-md ${CARD}`}>
          <div className="flex h-full gap-2">
            <span className="w-8 rounded-md bg-[var(--app-active-bg)]" />
            <span className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-terminal-bg)]" />
          </div>
          <Minimize2 className="absolute right-3 top-3 text-[var(--app-accent)]" size={16} />
        </div>
        <Maximize2 className="text-[var(--app-text-tertiary)] motion-safe:animate-pulse motion-reduce:animate-none" size={18} />
        <div className="flex h-28 w-20 items-center justify-center rounded-lg border border-[var(--app-accent)] bg-[var(--app-terminal-bg)] shadow-md">
          <Terminal className="text-[var(--app-accent)]" size={19} />
        </div>
      </div>
    </VisualStage>
  );
}

export function LauncherVisual() {
  return (
    <VisualStage>
      <div className={`w-full max-w-[310px] p-3 shadow-md ${CARD}`}>
        <div className="mb-3 flex items-center gap-2 text-[var(--app-accent)]">
          <Plus size={16} />
          <span className="h-1.5 w-24 rounded-full bg-[var(--app-active-bg)]" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[Terminal, AppWindow, Command, LayoutGrid].map((Icon, index) => (
            <div
              key={index}
              className={`flex h-16 items-center gap-2 rounded-md border px-3 ${index === 0 ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "border-[var(--app-border)]"}`}
            >
              <Icon size={16} />
              <span className={`h-1.5 flex-1 ${SKELETON}`} />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

export function InterfaceShapesVisual() {
  return (
    <VisualStage>
      <div className="grid w-full max-w-[320px] grid-cols-3 gap-2">
        {THEME_SHAPES.map((shape) => (
          <div
            key={shape.code}
            className="theme-shape-preview relative h-20 overflow-hidden border border-[var(--app-border)]"
            data-shape-preview={shape.code}
          >
            <span className="theme-shape-preview-chrome absolute inset-x-0 top-0 h-4 border-b border-[var(--app-border)]" />
            <span className="theme-shape-preview-sidebar absolute bottom-2 left-2 top-6 w-4 border border-[var(--app-border)]" />
            <span className="theme-shape-preview-panel absolute bottom-2 left-8 right-2 top-6 border border-[var(--app-border)]">
              <span className="absolute left-1 right-3 top-2 h-px bg-[var(--app-text-tertiary)] opacity-60" />
              <span className="absolute left-1 right-5 top-4 h-px bg-[var(--app-text-tertiary)] opacity-40" />
            </span>
          </div>
        ))}
      </div>
    </VisualStage>
  );
}

/** 灰底 + 延迟浮现的彩色覆盖层：终态即静态色，reduced-motion 下直接是终态。 */
function StatusDot({ color, step }: { color: string; step: number }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 rounded-full bg-[var(--app-text-tertiary)]" />
      <span
        className="tip-demo-rise absolute inset-0 rounded-full"
        style={{ backgroundColor: color, ...delay(step) }}
      />
    </span>
  );
}

/**
 * ① 派工编排：一个 leader 连三个 worker。
 * 三个 worker 用不同 delay 依次落位，终态是「一蓝两绿」（一个还在跑、两个已完成）。
 */
export function DispatchOrchestrationVisual() {
  const workers = [
    { color: "var(--app-accent)", step: 1 },
    { color: "var(--app-status-success)", step: 2 },
    { color: "var(--app-status-success)", step: 3 },
  ];
  return (
    <VisualStage>
      <div className="flex w-full max-w-[300px] flex-col items-center gap-2">
        <div className={`flex w-40 items-center gap-2 px-3 py-2 shadow-md ${CARD}`}>
          <Sparkles className="text-[var(--app-accent)]" size={14} />
          <span className={`h-1.5 flex-1 ${SKELETON}`} />
        </div>
        <svg width="200" height="26" viewBox="0 0 200 26" fill="none" className="text-[var(--app-border)]">
          <path
            d="M100 0 V10 M22 26 V16 H178 V26 M100 10 V16"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <div className="grid w-full grid-cols-3 gap-2">
          {workers.map((worker, index) => (
            <div
              key={index}
              className={`tip-demo-rise flex flex-col gap-2 p-2 ${CARD}`}
              style={delay(worker.step)}
            >
              <div className="flex items-center gap-1.5">
                <StatusDot color={worker.color} step={worker.step} />
                <span className={`h-1 flex-1 ${SKELETON}`} />
              </div>
              <span className={`h-1 w-2/3 ${SKELETON}`} />
              <span className={`h-1 w-1/2 ${SKELETON}`} />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

/**
 * ② worktree 隔离：主节点（干净）+ 两个缩进子节点（各有改动）。
 * 静态——论点是「别动我主树」，不需要时间维度。
 */
export function WorktreeIsolationVisual() {
  return (
    <VisualStage>
      <div className={`w-full max-w-[280px] p-3 shadow-md ${CARD}`}>
        <div className="flex items-center gap-2 py-1.5">
          <GitBranch size={14} className="text-[var(--app-text-tertiary)]" />
          <span className={`h-1.5 w-24 ${SKELETON}`} />
          <Check size={14} className="ml-auto text-[var(--app-status-success)]" />
        </div>
        {[0, 1].map((index) => (
          <div key={index} className="flex items-center gap-2 py-1.5 pl-5">
            <span className="h-4 w-3 rounded-bl-md border-b border-l border-[var(--app-border)]" />
            <GitBranch size={13} className="text-[var(--app-text-tertiary)]" />
            <span className={`h-1.5 ${index === 0 ? "w-20" : "w-16"} ${SKELETON}`} />
            <span
              className="ml-auto size-2 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--app-accent)" }}
            />
          </div>
        ))}
      </div>
    </VisualStage>
  );
}

/** ③ AI 面板：终端 → 面板，面板内骨架条按 delay 依次淡入。 */
export function AiPanelVisual() {
  return (
    <VisualStage>
      <div className="flex w-full max-w-[320px] items-center gap-2">
        <div className="flex h-28 flex-1 flex-col gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-terminal-bg)] p-2">
          <Terminal size={13} className="text-[var(--app-text-tertiary)]" />
          <span className={`h-1 w-4/5 ${SKELETON}`} />
          <span className={`h-1 w-3/5 ${SKELETON}`} />
        </div>
        <ArrowRight size={16} className="shrink-0 text-[var(--app-accent)]" />
        <div className={`flex h-28 flex-1 flex-col gap-2 p-2 shadow-md ${CARD}`}>
          <div className="flex items-center gap-1.5 border-b border-[var(--app-border)] pb-1.5">
            <Sparkles size={12} className="text-[var(--app-accent)]" />
            <span className={`h-1 w-12 ${SKELETON}`} />
          </div>
          {[1, 2, 3].map((step) => (
            <span
              key={step}
              className={`tip-demo-rise h-1.5 ${SKELETON} ${step === 3 ? "w-1/2" : "w-full"}`}
              style={delay(step)}
            />
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

/** ④ skill 体系：输入框 + 下方 5 条列表，第 2 条高亮。静态。 */
export function SkillsVisual() {
  return (
    <VisualStage>
      <div className={`w-full max-w-[290px] overflow-hidden shadow-md ${CARD}`}>
        <div className="flex h-9 items-center gap-2 border-b border-[var(--app-border)] px-3">
          <Slash size={13} className="text-[var(--app-accent)]" />
          <span className={`h-1.5 w-16 ${SKELETON}`} />
        </div>
        <div className="space-y-1 p-2">
          {["w-4/5", "w-2/3", "w-3/4", "w-1/2", "w-3/5"].map((width, index) => (
            <div
              key={width}
              className={`flex h-7 items-center gap-2 rounded-md px-2 ${index === 1 ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "text-[var(--app-text-tertiary)]"}`}
            >
              <Sparkles size={12} />
              <span className={`h-1.5 ${width} ${SKELETON}`} />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

/**
 * ⑤ 右坞：主区域 + 右侧推入的窄栏，栏内两个 tab（第一个选中）。
 * 不画快捷键 chip——那三个视图动作没有默认绑定、设置页也绑不上（docs/guide/19）。
 */
export function RightDockVisual() {
  return (
    <VisualStage>
      <div className={`flex h-32 w-full max-w-[300px] overflow-hidden shadow-md ${CARD}`}>
        <div className="flex flex-1 flex-col gap-1.5 border-r border-[var(--app-border)] bg-[var(--app-terminal-bg)] p-2">
          <span className={`h-1 w-3/4 ${SKELETON}`} />
          <span className={`h-1 w-1/2 ${SKELETON}`} />
          <span className={`h-1 w-2/3 ${SKELETON}`} />
        </div>
        <div className="tip-demo-slide-in flex w-[110px] flex-col bg-[var(--app-panel-bg)]">
          <div className="flex items-center gap-1 border-b border-[var(--app-border)] px-1.5 py-1">
            <span className="flex size-6 items-center justify-center rounded bg-[var(--app-active-bg)] text-[var(--app-accent)]">
              <GitBranch size={12} />
            </span>
            <span className="flex size-6 items-center justify-center rounded text-[var(--app-text-tertiary)]">
              <Files size={12} />
            </span>
            <PanelRight size={12} className="ml-auto text-[var(--app-text-tertiary)]" />
          </div>
          <div className="flex flex-col gap-1.5 p-2">
            {["w-full", "w-4/5", "w-3/5"].map((width, index) => (
              <span
                key={width}
                className={`tip-demo-rise h-1 ${width} ${SKELETON}`}
                style={delay(index + 1)}
              />
            ))}
          </div>
        </div>
      </div>
    </VisualStage>
  );
}

/**
 * ⑥ 浏览器标签：箭头从 agent 指向页面。
 * 方向不能反——反了就变成「你去开」，而用户根本没有打开它的入口（docs/guide/20）。
 */
export function BrowserTabVisual() {
  return (
    <VisualStage>
      <div className="flex w-full max-w-[320px] items-center gap-2">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <span className="flex size-9 items-center justify-center rounded-lg border border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]">
            <Bot size={17} />
          </span>
          <span className={`h-1 w-8 ${SKELETON}`} />
        </div>
        <ArrowRight size={16} className="shrink-0 text-[var(--app-accent)]" />
        <div className={`flex h-28 flex-1 flex-col overflow-hidden shadow-md ${CARD}`}>
          <div className="flex items-center gap-1.5 border-b border-[var(--app-border)] px-2 py-1.5">
            <Globe size={12} className="text-[var(--app-text-tertiary)]" />
            <span className="h-4 flex-1 rounded-full border border-[var(--app-border)]" />
          </div>
          <div className="flex flex-1 flex-col gap-1.5 p-2">
            <span
              className={`tip-demo-rise h-1.5 w-2/3 ${SKELETON}`}
              style={delay(1)}
            />
            <span
              className="tip-demo-rise h-10 w-full rounded-md bg-[var(--app-hover)]"
              style={delay(2)}
            />
          </div>
        </div>
      </div>
    </VisualStage>
  );
}
