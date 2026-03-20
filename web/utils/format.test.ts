import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime, formatFullTime, formatSize } from "./format";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 固定当前时间为 2025-01-15T12:00:00.000Z
    vi.setSystemTime(new Date("2025-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("时间差 < 60 秒返回 '刚刚'", () => {
    expect(formatRelativeTime("2025-01-15T12:00:00.000Z")).toBe("刚刚");
    expect(formatRelativeTime("2025-01-15T11:59:01.000Z")).toBe("刚刚");
    expect(formatRelativeTime("2025-01-15T11:59:30.000Z")).toBe("刚刚");
  });

  it("1-59 分钟返回 'X 分钟前'", () => {
    expect(formatRelativeTime("2025-01-15T11:59:00.000Z")).toBe("1 分钟前");
    expect(formatRelativeTime("2025-01-15T11:30:00.000Z")).toBe("30 分钟前");
    expect(formatRelativeTime("2025-01-15T11:01:00.000Z")).toBe("59 分钟前");
  });

  it("1-23 小时返回 'X 小时前'", () => {
    expect(formatRelativeTime("2025-01-15T11:00:00.000Z")).toBe("1 小时前");
    expect(formatRelativeTime("2025-01-15T00:00:00.000Z")).toBe("12 小时前");
    expect(formatRelativeTime("2025-01-14T13:00:00.000Z")).toBe("23 小时前");
  });

  it("1-6 天返回 'X 天前'", () => {
    expect(formatRelativeTime("2025-01-14T12:00:00.000Z")).toBe("1 天前");
    expect(formatRelativeTime("2025-01-12T12:00:00.000Z")).toBe("3 天前");
    expect(formatRelativeTime("2025-01-09T12:00:00.000Z")).toBe("6 天前");
  });

  it(">= 7 天返回 toLocaleDateString 格式", () => {
    const isoString = "2025-01-08T12:00:00.000Z";
    const expected = new Date(isoString).toLocaleDateString();
    expect(formatRelativeTime(isoString)).toBe(expected);
  });

  it(">= 7 天 - 更早的日期", () => {
    const isoString = "2024-06-01T00:00:00.000Z";
    const expected = new Date(isoString).toLocaleDateString();
    expect(formatRelativeTime(isoString)).toBe(expected);
  });
});

describe("formatFullTime", () => {
  it("返回 toLocaleString 格式的非空字符串", () => {
    const isoString = "2025-01-15T12:30:45.000Z";
    const result = formatFullTime(isoString);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("返回值与 Date.toLocaleString 一致", () => {
    const isoString = "2025-01-15T12:30:45.000Z";
    const expected = new Date(isoString).toLocaleString();
    expect(formatFullTime(isoString)).toBe(expected);
  });
});

describe("formatSize", () => {
  it("0 字节", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("小于 1024 字节显示 B", () => {
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("边界值 1024 显示 KB", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
  });

  it("KB 范围", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 100)).toBe("100.0 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("边界值 1048576 显示 MB", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("MB 范围", () => {
    expect(formatSize(1048576 * 5)).toBe("5.0 MB");
    expect(formatSize(1048576 * 100)).toBe("100.0 MB");
    expect(formatSize(1024 * 1024 * 1024 - 1)).toBe("1024.0 MB");
  });

  it("边界值 1073741824 显示 GB", () => {
    expect(formatSize(1073741824)).toBe("1.00 GB");
  });

  it("GB 范围", () => {
    expect(formatSize(1073741824 * 2.5)).toBe("2.50 GB");
    expect(formatSize(1073741824 * 10)).toBe("10.00 GB");
  });
});
