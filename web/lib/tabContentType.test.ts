import { describe, expect, it } from "vitest";
import {
  TAB_CONTENT_GROUP,
  TAB_CONTENT_GROUPS,
  TAB_CONTENT_ICON,
  TAB_GROUP_ICON,
  TAB_GROUP_LABEL_KEY,
  tabContentGroup,
} from "./tabContentType";
import type { TabContentType } from "./tabContentType";

// contentType 的**全集**。新增一种就要在这里加一条，随后下面三个穷举断言会逼着
// 你同步 TAB_CONTENT_GROUP / TAB_CONTENT_ICON —— 漏了会让新类型在布局卡片上
// 静默不计数（总数对不上 tab 实际数量），且在 TabBar 上没有图标。
const ALL_CONTENT_TYPES: TabContentType[] = [
  "terminal",
  "browser",
  "dsh",
  "agent-chat",
  "editor",
  "file-explorer",
  "mcp-config",
  "skill-manager",
  "memory-manager",
];

describe("tabContentType", () => {
  it("每种 contentType 都有归组，且落在四桁之内", () => {
    for (const type of ALL_CONTENT_TYPES) {
      const group = TAB_CONTENT_GROUP[type];
      expect(group, `${type} 缺少归组`).toBeDefined();
      expect(TAB_CONTENT_GROUPS).toContain(group);
    }
  });

  it("映射表没有多余键（表与全集一一对应）", () => {
    expect(Object.keys(TAB_CONTENT_GROUP).sort()).toEqual([...ALL_CONTENT_TYPES].sort());
    expect(Object.keys(TAB_CONTENT_ICON).sort()).toEqual([...ALL_CONTENT_TYPES].sort());
  });

  it("每种 contentType 都有图标", () => {
    for (const type of ALL_CONTENT_TYPES) {
      expect(TAB_CONTENT_ICON[type], `${type} 缺少图标`).toBeTypeOf("object");
    }
  });

  it("四桁分组各有图标与 i18n key", () => {
    for (const group of TAB_CONTENT_GROUPS) {
      expect(TAB_GROUP_ICON[group], `${group} 缺少图标`).toBeDefined();
      expect(TAB_GROUP_LABEL_KEY[group], `${group} 缺少文案 key`).toBeTruthy();
    }
  });

  it("归组语义：editor 与 file-explorer 同属文件，三个管理面板同属工具", () => {
    expect(tabContentGroup("terminal")).toBe("terminal");
    expect(tabContentGroup("browser")).toBe("browser");
    expect(tabContentGroup("editor")).toBe("files");
    expect(tabContentGroup("file-explorer")).toBe("files");
    expect(tabContentGroup("mcp-config")).toBe("tools");
    expect(tabContentGroup("skill-manager")).toBe("tools");
    expect(tabContentGroup("memory-manager")).toBe("tools");
  });
});
