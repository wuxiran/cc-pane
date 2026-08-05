import { beforeEach, describe, expect, it } from "vitest";
import {
  terminalRestoreLogKey,
  useTerminalRestoreLogStore,
} from "./useTerminalRestoreLogStore";

describe("useTerminalRestoreLogStore", () => {
  beforeEach(() => useTerminalRestoreLogStore.getState().reset());

  it("keeps the latest 20 restore events per terminal leaf", () => {
    for (let index = 0; index < 25; index += 1) {
      useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", `event-${index}`);
    }

    const logs = useTerminalRestoreLogStore.getState().logs[
      terminalRestoreLogKey("tab-1", "leaf-1")
    ];
    expect(logs).toHaveLength(20);
    expect(logs[0].event).toBe("event-5");
    expect(logs[19].event).toBe("event-24");
  });

  it("isolates logs by tab and leaf", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-a", "snapshot.begin");
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-b", "claim.begin");

    expect(useTerminalRestoreLogStore.getState().logs[
      terminalRestoreLogKey("tab-1", "leaf-a")
    ][0].event).toBe("snapshot.begin");
    expect(useTerminalRestoreLogStore.getState().logs[
      terminalRestoreLogKey("tab-1", "leaf-b")
    ][0].event).toBe("claim.begin");
  });

  it("keeps structured details and an ISO timestamp", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", "candidate.scan", { count: 2 });

    const [entry] = useTerminalRestoreLogStore.getState().logs[
      terminalRestoreLogKey("tab-1", "leaf-1")
    ];
    expect(entry.details).toEqual({ count: 2 });
    expect(Number.isNaN(new Date(entry.timestamp).getTime())).toBe(false);
  });
});
