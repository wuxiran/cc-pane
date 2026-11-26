import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CurrentActivityBadge from "./CurrentActivityBadge";
import { useTerminalStatusStore } from "@/stores";
import type { TaskBinding, TerminalStatusInfo } from "@/types";

function makeBinding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    id: "b1",
    title: "task",
    role: "task",
    projectPath: "/tmp/proj",
    cliTool: "claude",
    status: "running",
    progress: 0,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStatus(overrides: Partial<TerminalStatusInfo> = {}): TerminalStatusInfo {
  return {
    sessionId: "s1",
    status: "active",
    lastOutputAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function setStatus(sessionId: string, info: TerminalStatusInfo | null): void {
  const map = new Map<string, TerminalStatusInfo>();
  if (info) map.set(sessionId, info);
  useTerminalStatusStore.setState({ statusMap: map });
}

describe("CurrentActivityBadge", () => {
  beforeEach(() => {
    useTerminalStatusStore.setState({ statusMap: new Map() });
    vi.useFakeTimers({ now: new Date("2026-07-03T00:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[TaskBinding["status"], RegExp]>([
    ["waiting", /Waiting input/],
    ["pending", /Pending/],
    ["completed", /Done/],
    ["failed", /Failed/],
    ["running", /Thinking/],
  ])("binding status %s without tool info shows %s", (status, label) => {
    render(<CurrentActivityBadge binding={makeBinding({ status })} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it("shows Waiting input when terminal status is waitingInput", () => {
    setStatus("s1", makeStatus({ status: "waitingInput" }));
    render(<CurrentActivityBadge binding={makeBinding({ status: "running", sessionId: "s1" })} />);
    expect(screen.getByText(/Waiting input/)).toBeVisible();
  });

  it("renders a Bash tool label with a compacted summary", () => {
    setStatus(
      "s1",
      makeStatus({ status: "active", currentToolName: "Bash", currentToolSummary: "  npm   run   build  " }),
    );
    render(<CurrentActivityBadge binding={makeBinding({ status: "running", sessionId: "s1" })} />);
    expect(screen.getByText(/Bash 'npm run build'/)).toBeVisible();
  });

  it.each([
    ["Edit", "file.ts", /🔧 Edit file.ts/],
    ["Grep", "pattern", /🔎 Grep pattern/],
  ])("renders the %s tool label with its category icon", (currentToolName, currentToolSummary, label) => {
    setStatus("s1", makeStatus({ currentToolName, currentToolSummary }));
    render(<CurrentActivityBadge binding={makeBinding({ status: "running", sessionId: "s1" })} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it("truncates long tool summaries beyond 32 chars", () => {
    const longSummary = "x".repeat(50);
    setStatus("s1", makeStatus({ currentToolName: "Write", currentToolSummary: longSummary }));
    render(<CurrentActivityBadge binding={makeBinding({ status: "running", sessionId: "s1" })} />);
    // 31 chars + ellipsis
    expect(screen.getByText(new RegExp(`${"x".repeat(31)}\\.\\.\\.`))).toBeVisible();
  });

  it("shows the stale 1m+ marker when running info is older than 60s", () => {
    const now = Date.now();
    setStatus("s1", makeStatus({ status: "active", updatedAt: now - 120000, currentToolName: "Bash" }));
    render(<CurrentActivityBadge binding={makeBinding({ status: "running", sessionId: "s1" })} />);
    expect(screen.getByText(/1m\+/)).toBeVisible();
  });

  it("derives duration from ui.startedAt in the title", () => {
    const started = Date.now() - 5 * 60000;
    render(
      <CurrentActivityBadge
        binding={makeBinding({ status: "running", metadata: { ui: { startedAt: started } } })}
      />,
    );
    // title is `${label} · ${duration}` -> 5m
    const el = screen.getByText(/Thinking/).closest("span[title]");
    expect(el?.getAttribute("title")).toMatch(/· 5m$/);
  });

  it("shows <1m duration for freshly started tasks", () => {
    render(
      <CurrentActivityBadge
        binding={makeBinding({ status: "pending", metadata: { ui: { startedAt: Date.now() } } })}
      />,
    );
    const el = screen.getByText(/Pending/).closest("span[title]");
    expect(el?.getAttribute("title")).toMatch(/· <1m$/);
  });
});
