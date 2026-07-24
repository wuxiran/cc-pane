import { describe, expect, it } from "vitest";

type LocaleValue = string | number | boolean | null | LocaleObject | LocaleValue[];
type LocaleObject = { [key: string]: LocaleValue };

const EN_MODULES = import.meta.glob("../i18n/locales/en/*.json", {
  import: "default",
  eager: true,
}) as Record<string, LocaleObject>;
const ZH_MODULES = import.meta.glob("../i18n/locales/zh-CN/*.json", {
  import: "default",
  eager: true,
}) as Record<string, LocaleObject>;

function namespaceFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1]?.replace(/\.json$/, "") ?? path;
}

function byNamespace(modules: Record<string, LocaleObject>): Map<string, LocaleObject> {
  return new Map(Object.entries(modules).map(([path, value]) => [namespaceFromPath(path), value]));
}

function flatten(value: LocaleValue, prefix = ""): Map<string, LocaleValue> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const flattened = new Map<string, LocaleValue>();
    for (const [key, child] of Object.entries(value)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      for (const entry of flatten(child, childPrefix)) flattened.set(...entry);
    }
    return flattened;
  }
  return new Map([[prefix, value]]);
}

function sortedDifference(left: Iterable<string>, right: Set<string>): string[] {
  return [...left].filter((key) => !right.has(key)).sort();
}

describe("i18n locale parity", () => {
  const en = byNamespace(EN_MODULES);
  const zh = byNamespace(ZH_MODULES);

  it("en 与 zh-CN namespace 清单全等", () => {
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort());
  });

  it("每个 namespace 的深层键双向全等且值非空", () => {
    const violations: string[] = [];
    const namespaces = [...new Set([...en.keys(), ...zh.keys()])].sort();

    for (const namespace of namespaces) {
      const enValues = flatten(en.get(namespace) ?? {});
      const zhValues = flatten(zh.get(namespace) ?? {});
      const enKeys = new Set(enValues.keys());
      const zhKeys = new Set(zhValues.keys());
      const missingInZh = sortedDifference(enKeys, zhKeys);
      const missingInEn = sortedDifference(zhKeys, enKeys);
      if (missingInZh.length > 0) {
        violations.push(`${namespace}: zh-CN 缺少 ${missingInZh.join(", ")}`);
      }
      if (missingInEn.length > 0) {
        violations.push(`${namespace}: en 缺少 ${missingInEn.join(", ")}`);
      }

      for (const [locale, values] of [
        ["en", enValues],
        ["zh-CN", zhValues],
      ] as const) {
        const emptyKeys = [...values]
          .filter(([, value]) => typeof value === "string" && value.trim() === "")
          .map(([key]) => key)
          .sort();
        if (emptyKeys.length > 0) {
          violations.push(`${namespace}: ${locale} 空值 ${emptyKeys.join(", ")}`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
