import i18n from "@/i18n";
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { TerminalRestoreLogEntry } from "@/stores/useTerminalRestoreLogStore";
import { formatRestoreLogEntry } from "./terminalRestoreLogFormat";

const t = i18n.getFixedT("zh-CN", "panes") as TFunction<"panes">;

function entry(
  event: string,
  details: Record<string, unknown> = {},
  timestamp = "2026-01-02T03:04:05.000Z",
): TerminalRestoreLogEntry {
  return { id: 1, timestamp, event, details };
}

describe("formatRestoreLogEntry", () => {
  it("renders the local HH:mm:ss time", () => {
    const iso = new Date(2026, 0, 2, 13, 4, 5).toISOString();
    expect(formatRestoreLogEntry(entry("attach.end", {}, iso), t).time).toBe("13:04:05");
  });

  it("interpolates counts into readable text", () => {
    const result = formatRestoreLogEntry(entry("candidate.scan", { count: 3 }), t);
    expect(result.text).toBe(t("restoreLog.events.candidate_scan", { count: 3 }));
    expect(result.text).toContain("3");
    expect(result.tone).toBe("info");
  });

  it("maps daemon snapshot session counts onto the shared count slot", () => {
    const result = formatRestoreLogEntry(entry("daemon-snapshot.end", { sessionCount: 7 }), t);
    expect(result.text).toContain("7");
  });

  it("picks the reason variant and shortens the session id", () => {
    const result = formatRestoreLogEntry(
      entry("identity.blocked", { reason: "identity-mismatch", sessionId: "sess-abcdef1234" }),
      t,
    );
    expect(result.text).toContain("sess-abc");
    expect(result.text).not.toContain("abcdef1234");
    expect(result.tone).toBe("error");
  });

  it("translates the candidate selection source", () => {
    const result = formatRestoreLogEntry(
      entry("candidate.selected", { sessionId: "sess-1234567890", source: "unique-anchor" }),
      t,
    );
    expect(result.text).toContain(t("restoreLog.source.unique-anchor"));
  });

  it("marks claim conflicts as a warning, not an error", () => {
    const result = formatRestoreLogEntry(
      entry("claim.blocked", { reason: "claim-conflict", owner: "other" }),
      t,
    );
    expect(result.text).toBe(t("restoreLog.events.claim_blocked__claim-conflict"));
    expect(result.tone).toBe("warn");
  });

  it("reports a clean reconcile pass as ok and a blocked one as warn", () => {
    const clean = formatRestoreLogEntry(
      entry("reconcile.end", { attached: 2, skipped: 1, blocked: 0 }),
      t,
    );
    expect(clean.text).toBe(
      t("restoreLog.events.reconcile_end", { attached: 2, skipped: 1, blocked: 0 }),
    );
    expect(clean.tone).toBe("ok");

    expect(
      formatRestoreLogEntry(entry("reconcile.end", { attached: 0, skipped: 0, blocked: 1 }), t)
        .tone,
    ).toBe("warn");
  });

  it("falls back to event name plus raw details for unknown events", () => {
    const result = formatRestoreLogEntry(entry("brand.new.event", { foo: 1 }), t);
    expect(result.text).toContain("brand.new.event");
    expect(result.text).toContain('{"foo":1}');
  });

  it("always keeps the raw event and details available", () => {
    const result = formatRestoreLogEntry(entry("attach.end", { sessionId: "sess-1" }), t);
    expect(result.raw).toBe('attach.end {"sessionId":"sess-1"}');
    expect(result.tone).toBe("ok");
  });
});
