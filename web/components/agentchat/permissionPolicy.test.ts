import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVE_ALL,
  PERMISSION_GROUPS,
  enabledGroupCount,
  isGroupEnabled,
  normalize,
  presetKinds,
  presetOf,
  toggleAll,
  toggleGroup,
} from "./permissionPolicy";

const group = (id: string) => {
  const found = PERMISSION_GROUPS.find((item) => item.id === id);
  if (!found) throw new Error(`missing group ${id}`);
  return found;
};

describe("permissionPolicy", () => {
  it("空集合没有任何组被勾选", () => {
    expect(enabledGroupCount([])).toBe(0);
    expect(isGroupEnabled([], group("read"))).toBe(false);
  });

  it("勾选一组展开成组内全部 kind", () => {
    const kinds = toggleGroup([], group("edit"));
    expect(kinds.sort()).toEqual(["delete", "edit", "move"]);
    expect(isGroupEnabled(kinds, group("edit"))).toBe(true);
    expect(isGroupEnabled(kinds, group("read"))).toBe(false);
  });

  it("再点一次取消该组，其他组保留", () => {
    const withTwo = toggleGroup(toggleGroup([], group("read")), group("execute"));
    const withoutRead = toggleGroup(withTwo, group("read"));
    expect(withoutRead).toEqual(["execute"]);
  });

  it("所有组都勾上时折叠为通配", () => {
    let kinds: string[] = [];
    for (const item of PERMISSION_GROUPS) kinds = toggleGroup(kinds, item);
    expect(kinds).toEqual([AUTO_APPROVE_ALL]);
    expect(enabledGroupCount(kinds)).toBe(PERMISSION_GROUPS.length);
  });

  it("从通配态取消一组会展开成其余组的 kind", () => {
    const kinds = toggleGroup([AUTO_APPROVE_ALL], group("execute"));
    expect(kinds).not.toContain(AUTO_APPROVE_ALL);
    expect(kinds).not.toContain("execute");
    expect(isGroupEnabled(kinds, group("read"))).toBe(true);
    expect(isGroupEnabled(kinds, group("other"))).toBe(true);
  });

  it("toggleAll 在通配与空之间切换", () => {
    expect(toggleAll([])).toEqual([AUTO_APPROVE_ALL]);
    expect(toggleAll([AUTO_APPROVE_ALL])).toEqual([]);
    expect(toggleAll(["read"])).toEqual([AUTO_APPROVE_ALL]);
  });

  it("normalize 去重并剔除悬空通配", () => {
    expect(normalize(["read", "read", AUTO_APPROVE_ALL])).toEqual(["read"]);
  });
});

describe("三档预设", () => {
  it("空集合是「请求批准」，通配是「完全访问」", () => {
    expect(presetOf([])).toBe("ask");
    expect(presetOf([AUTO_APPROVE_ALL])).toBe("full");
    expect(presetOf(["read", AUTO_APPROVE_ALL])).toBe("full");
  });

  it("「帮我批准」放行读和改，不放行执行命令、联网和其它工具", () => {
    const kinds = presetKinds("assist");
    expect(presetOf(kinds)).toBe("assist");
    expect(presetOf([...kinds].reverse())).toBe("assist");
    for (const risky of ["execute", "fetch", "other"]) expect(kinds).not.toContain(risky);
    for (const safe of ["read", "search", "edit"]) expect(kinds).toContain(safe);
  });

  it("对不上任何一档的集合是自定义", () => {
    expect(presetOf(["read", "search"])).toBeNull();
    expect(presetOf([...presetKinds("assist"), "execute"])).toBeNull();
  });

  it("presetKinds 返回的是副本，改它不会污染预设", () => {
    presetKinds("assist").push("execute");
    expect(presetKinds("assist")).not.toContain("execute");
  });
});

