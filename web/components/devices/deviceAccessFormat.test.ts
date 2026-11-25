import { describe, expect, it } from "vitest";
import { describeLastSeen, ONLINE_WINDOW_MS, summarizeUserAgent } from "./deviceAccessFormat";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("describeLastSeen", () => {
  it("两分钟内算在线（后端每分钟至多记录一次）", () => {
    expect(describeLastSeen(ago(0), NOW)).toEqual({ kind: "online" });
    expect(describeLastSeen(ago(ONLINE_WINDOW_MS), NOW)).toEqual({ kind: "online" });
    expect(describeLastSeen(ago(ONLINE_WINDOW_MS + 60_000), NOW)).toEqual({ kind: "minutes", count: 3 });
  });

  it("按分钟 / 小时 / 天分档，未连接过或无法解析为 never", () => {
    expect(describeLastSeen(ago(59 * 60_000), NOW)).toEqual({ kind: "minutes", count: 59 });
    expect(describeLastSeen(ago(5 * 3_600_000), NOW)).toEqual({ kind: "hours", count: 5 });
    expect(describeLastSeen(ago(3 * 86_400_000), NOW)).toEqual({ kind: "days", count: 3 });
    expect(describeLastSeen(null, NOW)).toEqual({ kind: "never" });
    expect(describeLastSeen("garbage", NOW)).toEqual({ kind: "never" });
  });
});

describe("summarizeUserAgent", () => {
  it("识别常见浏览器与系统", () => {
    expect(summarizeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"))
      .toBe("Chrome · macOS");
    expect(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0"))
      .toBe("Edge · Windows");
    expect(summarizeUserAgent("Mozilla/5.0 (Linux; Android 14) Firefox/130.0")).toBe("Firefox · Android");
    expect(summarizeUserAgent("curl/8.0")).toBeNull();
    expect(summarizeUserAgent(null)).toBeNull();
  });
});
