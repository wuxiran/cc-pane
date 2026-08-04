import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalLaunchTimeoutError,
  withTerminalLaunchDeadline,
} from "./terminalLaunchDeadline";

describe("terminal launch deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects with a structured timeout and invokes cancellation once", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const pending = new Promise<string>(() => {});
    const result = withTerminalLaunchDeadline(pending, "launch-1", cancel, 100);
    const assertion = expect(result).rejects.toEqual(createTerminalLaunchTimeoutError("launch-1", 100));

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps a late success from rebinding the failed launch", async () => {
    let resolve!: (value: string) => void;
    const task = new Promise<string>((res) => {
      resolve = res;
    });
    const result = withTerminalLaunchDeadline(task, "launch-2", undefined, 1);
    const assertion = expect(result).rejects.toMatchObject({ code: "LAUNCH_TIMEOUT" });
    await new Promise((r) => setTimeout(r, 5));
    await assertion;
    resolve("late-session");
    await Promise.resolve();
  });
});
