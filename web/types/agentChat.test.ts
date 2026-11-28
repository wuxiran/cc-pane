import { describe, expect, it } from "vitest";
import { normalizeAcpConfigOptions, normalizeAcpSnapshot, type AcpConfigOption } from "./agentChat";

describe("normalizeAcpConfigOptions", () => {
  it("id 兜底为 configId，configId 优先", () => {
    const options = [
      { id: "model", category: "model" },
      { configId: "effort", id: "other" },
      { configId: "", id: "mode" },
      { name: "no id" },
    ] as unknown as AcpConfigOption[];
    const normalized = normalizeAcpConfigOptions(options)!;
    expect(normalized.map((option) => option.configId)).toEqual(["model", "effort", "mode", undefined]);
    expect(normalized[0].id).toBe("model");
    expect(options[0].configId).toBeUndefined();
  });

  it("无需改动时返回原引用", () => {
    const options: AcpConfigOption[] = [{ configId: "a" }];
    expect(normalizeAcpConfigOptions(options)).toBe(options);
    expect(normalizeAcpConfigOptions(undefined)).toBeUndefined();
    const snapshot = { configOptions: options };
    expect(normalizeAcpSnapshot(snapshot)).toBe(snapshot);
  });

  it("快照归一化", () => {
    const snapshot = { configOptions: [{ id: "model" }] as unknown as AcpConfigOption[] };
    expect(normalizeAcpSnapshot(snapshot).configOptions?.[0].configId).toBe("model");
  });
});
