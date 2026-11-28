import { afterEach, expect, it, vi } from "vitest";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import { isFocusReportOnly, recordTerminalInputActivity } from "./terminalInputActivity";

afterEach(() => useTerminalInputActivityStore.getState().clearSession("s-focus"));

it("treats xterm focus reports as switching, not typing", () => {
  expect(isFocusReportOnly("\x1b[I")).toBe(true);
  expect(isFocusReportOnly("\x1b[O\x1b[I")).toBe(true);
  expect(isFocusReportOnly("a")).toBe(false);
  expect(isFocusReportOnly("\x1b[Ia")).toBe(false);
  expect(isFocusReportOnly("")).toBe(false);
});

it("does not refresh lastInputAt when a terminal only reports focus", async () => {
  recordTerminalInputActivity("s-focus", "\x1b[I");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(useTerminalInputActivityStore.getState().getEntry("s-focus")).toBeUndefined();
  recordTerminalInputActivity("s-focus", "x");
  await vi.waitFor(() => expect(useTerminalInputActivityStore.getState().getEntry("s-focus")).toBeDefined());
});
