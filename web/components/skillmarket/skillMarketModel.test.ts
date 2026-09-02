import { describe, expect, it } from "vitest";
import type { SkillMarketEntry } from "@/types";
import {
  categoryOf,
  filterByCategory,
  formatInstalls,
  iconGlyph,
  needsDescription,
  pickFeatured,
  presentCategories,
  toneFor,
} from "./skillMarketModel";

function entry(overrides: Partial<SkillMarketEntry> & { id: string }): SkillMarketEntry {
  return {
    name: overrides.id,
    tags: [],
    version: "latest",
    recommended: false,
    source: "curated",
    featured: false,
    ...overrides,
  };
}

describe("skillMarketModel", () => {
  it("categoryOf 未知或缺失分类归入 other", () => {
    expect(categoryOf(entry({ id: "a", category: "docs" }))).toBe("docs");
    expect(categoryOf(entry({ id: "b", category: "weird" }))).toBe("other");
    expect(categoryOf(entry({ id: "c", category: null }))).toBe("other");
  });

  it("presentCategories 按固定顺序只返回出现过的分类", () => {
    const entries = [
      entry({ id: "1", category: "design" }),
      entry({ id: "2", category: "dev" }),
      entry({ id: "3", category: "nope" }),
    ];
    expect(presentCategories(entries)).toEqual(["dev", "design", "other"]);
  });

  it("filterByCategory 支持 all 与具体分类", () => {
    const entries = [entry({ id: "1", category: "dev" }), entry({ id: "2", category: "docs" })];
    expect(filterByCategory(entries, "all")).toHaveLength(2);
    expect(filterByCategory(entries, "docs").map((e) => e.id)).toEqual(["2"]);
  });

  it("pickFeatured 先取 featured，再按安装量用 recommended 补位且不重复", () => {
    const entries = [
      entry({ id: "f1", featured: true }),
      entry({ id: "r-low", recommended: true, installs: 10 }),
      entry({ id: "r-high", recommended: true, installs: 999 }),
      entry({ id: "plain" }),
      entry({ id: "f2", featured: true, recommended: true, installs: 5 }),
    ];
    expect(pickFeatured(entries, 3).map((e) => e.id)).toEqual(["f1", "f2", "r-high"]);
    expect(pickFeatured(entries, 1).map((e) => e.id)).toEqual(["f1"]);
  });

  it("formatInstalls 压缩为 k/M，非正数返回 null", () => {
    expect(formatInstalls(0)).toBeNull();
    expect(formatInstalls(null)).toBeNull();
    expect(formatInstalls(999)).toBe("999");
    expect(formatInstalls(1000)).toBe("1k");
    expect(formatInstalls(1234)).toBe("1.2k");
    expect(formatInstalls(815_740)).toBe("815.7k");
    expect(formatInstalls(1_200_000)).toBe("1.2M");
  });

  it("toneFor 对同一名称稳定，iconGlyph 取首字符大写", () => {
    expect(toneFor("pdf")).toBe(toneFor("pdf"));
    expect(iconGlyph("obsidian")).toBe("O");
    expect(iconGlyph("小红书文案")).toBe("小");
    expect(iconGlyph("   ")).toBe("?");
  });

  it("needsDescription 只对有仓库且缺描述的条目为真", () => {
    expect(needsDescription(entry({ id: "a", repo: "o/r" }))).toBe(true);
    expect(needsDescription(entry({ id: "b", repo: "o/r", description: "x" }))).toBe(false);
    expect(needsDescription(entry({ id: "c", description: null }))).toBe(false);
  });
});
