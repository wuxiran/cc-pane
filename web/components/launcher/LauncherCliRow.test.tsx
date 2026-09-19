import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { listCliTools } from "@/services/cliToolService";
import { CLI_TOOLS_REQUEST_TIMEOUT_MS } from "@/hooks/useCliTools";
import type { CliToolInfo } from "@/types";
import LauncherCliRow from "./LauncherCliRow";

vi.mock("@/services/cliToolService", () => ({ listCliTools: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("pending and timed-out detection leave launch choices enabled; late confirmed absence disables only that tool", async () => {
  vi.useFakeTimers();
  let resolve!: (tools: CliToolInfo[]) => void;
  vi.mocked(listCliTools).mockReturnValue(new Promise((done) => { resolve = done; }));
  const onChange = vi.fn();
  render(<LauncherCliRow value="none" onChange={onChange} />);
  const claude = screen.getByRole("button", { name: "Claude Code" });
  const codex = screen.getByRole("button", { name: "Codex" });
  expect(claude).toBeEnabled();
  expect(codex).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(CLI_TOOLS_REQUEST_TIMEOUT_MS); });
  fireEvent.click(codex);
  expect(onChange).toHaveBeenCalledWith("codex");
  await act(async () => {
    resolve([
      { id: "claude", displayName: "Claude", executable: "claude", versionArgs: [], installed: true, version: null, path: null },
      { id: "codex", displayName: "Codex", executable: "codex", versionArgs: [], installed: false, version: null, path: null },
    ]);
  });
  expect(claude).toBeEnabled();
  expect(codex).toBeDisabled();
});

describe("failed detection", () => {
  it("keeps installed state unknown without disabling launch buttons", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listCliTools).mockRejectedValue(new Error("IPC unavailable"));
    render(<LauncherCliRow value="none" onChange={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Claude Code" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Codex" })).toBeEnabled();
  });
});
