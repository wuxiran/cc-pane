import { describe, expect, it } from "vitest";
import type { SshConnectivityResult } from "@/types";
import {
  detectedCcPanes,
  osLabelKey,
  resolveMachineCcPanesAction,
  runWithConcurrency,
} from "./sshMachineProbe";

function probe(overrides: Partial<SshConnectivityResult> = {}): SshConnectivityResult {
  return { reachable: true, message: "ok", latencyMs: 3, ...overrides };
}

const ccPanes = { baseUrl: "http://10.0.0.2:18081", port: 18081, pairingSupported: true };

describe("resolveMachineCcPanesAction", () => {
  it("offers deploy only for reachable Linux / macOS hosts", () => {
    expect(resolveMachineCcPanesAction(false, probe({ os: "linux" }))).toEqual({ kind: "deploy" });
    expect(resolveMachineCcPanesAction(false, probe({ os: "macos" }))).toEqual({ kind: "deploy" });
    expect(resolveMachineCcPanesAction(false, probe({ os: "windows" }))).toBeNull();
    expect(resolveMachineCcPanesAction(false, probe({ os: "freebsd" }))).toBeNull();
  });

  it("offers nothing before the probe finishes or on older backends", () => {
    expect(resolveMachineCcPanesAction(false, null)).toBeNull();
    expect(resolveMachineCcPanesAction(false, "checking")).toBeNull();
    expect(resolveMachineCcPanesAction(false, probe())).toBeNull();
    expect(resolveMachineCcPanesAction(false, probe({ os: null, ccPanes: null }))).toBeNull();
    expect(resolveMachineCcPanesAction(false, probe({ reachable: false, os: "linux" }))).toBeNull();
  });

  it("prefers connect when CC-Panes already runs there", () => {
    expect(resolveMachineCcPanesAction(false, probe({ os: "linux", ccPanes }))).toEqual({ kind: "connect", ccPanes });
    expect(resolveMachineCcPanesAction(false, probe({ os: "windows", ccPanes }))).toEqual({ kind: "connect", ccPanes });
  });

  it("offers nothing once a device is linked to the host", () => {
    expect(resolveMachineCcPanesAction(true, probe({ os: "linux" }))).toBeNull();
    expect(resolveMachineCcPanesAction(true, probe({ os: "linux", ccPanes }))).toBeNull();
  });
});

describe("probe display helpers", () => {
  it("maps known systems to labels and ignores the rest", () => {
    expect(osLabelKey(probe({ os: "windows" }))).toBe("machines.osWindows");
    expect(osLabelKey(probe({ os: "macOS" }))).toBe("machines.osMacos");
    expect(osLabelKey(probe({ os: "constructor" }))).toBeNull();
    expect(osLabelKey("checking")).toBeNull();
  });

  it("only reports CC-Panes on reachable results", () => {
    expect(detectedCcPanes(probe({ ccPanes }))).toEqual(ccPanes);
    expect(detectedCcPanes(probe({ reachable: false, ccPanes }))).toBeNull();
  });
});

describe("runWithConcurrency", () => {
  it("never exceeds the limit and runs every id once", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    await runWithConcurrency(["a", "b", "c", "d", "e"], 2, async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(id);
      inFlight -= 1;
    });
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("stops picking new work once asked to", async () => {
    const seen: string[] = [];
    let stop = false;
    await runWithConcurrency(["a", "b", "c"], 1, async (id) => {
      seen.push(id);
      stop = true;
    }, () => stop);
    expect(seen).toEqual(["a"]);
  });
});
