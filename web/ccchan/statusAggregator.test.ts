import { describe, expect, it } from "vitest";
import type { TerminalStatusType } from "@/types";
import { aggregateStatus } from "./statusAggregator";

describe("aggregateStatus", () => {
  it("returns idle for an empty list", () => {
    expect(aggregateStatus([])).toBe("idle");
  });

  it("returns idle for a single idle status", () => {
    expect(aggregateStatus(["idle"])).toBe("idle");
  });

  it("returns sad for a single error status", () => {
    expect(aggregateStatus(["error"])).toBe("sad");
  });

  it("prioritizes error over working and idle statuses", () => {
    const statuses: TerminalStatusType[] = ["error", "toolRunning", "idle"];
    expect(aggregateStatus(statuses)).toBe("sad");
  });
});
