import { describe, expect, it } from "vitest";
import { botIsLive, isTerminalStatus, mergeOutbox, type OutboxEntry } from "./botMesh";

function entry(id: string, createdAt: number, status: OutboxEntry["status"] = "queued"): OutboxEntry {
  return {
    id, deviceId: "d", deviceName: "D", botId: "b", botName: "B", text: "t", traceId: "tr", hops: 0,
    sender: "desktop", status, pendingPermissions: [], createdAt, updatedAt: createdAt,
  };
}

describe("botMesh helpers", () => {
  it("merges outbox updates by id, newest first", () => {
    const list = mergeOutbox(mergeOutbox([], entry("a", 1)), entry("b", 2));
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
    const updated = mergeOutbox(list, entry("a", 1, "done"));
    expect(updated.map((e) => e.id)).toEqual(["b", "a"]);
    expect(updated[1].status).toBe("done");
  });

  it("classifies statuses", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("waiting_permission")).toBe(false);
    expect(botIsLive("ready")).toBe(true);
    expect(botIsLive("idle")).toBe(false);
  });
});
