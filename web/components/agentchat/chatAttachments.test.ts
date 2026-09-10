import { describe, expect, it } from "vitest";
import { baseName, isImagePath, planPathAttachment } from "./chatAttachments";

describe("baseName", () => {
  it("Windows / Unix 路径都取末段文件名", () => {
    expect(baseName("C:\\dir\\a.png")).toBe("a.png");
    expect(baseName("/home/u/b.md")).toBe("b.md");
    expect(baseName("c.txt")).toBe("c.txt");
  });
});

describe("isImagePath", () => {
  it("图片扩展名大小写不敏感命中，其余不命中", () => {
    expect(isImagePath("C:\\a\\shot.PNG")).toBe(true);
    expect(isImagePath("b.jpeg")).toBe(true);
    expect(isImagePath("c.md")).toBe(false);
    expect(isImagePath("noext")).toBe(false);
  });
});

describe("planPathAttachment", () => {
  it("图片且引擎支持才内嵌 image，其余一律 resource_link 文件引用", () => {
    expect(planPathAttachment("C:\\a.png", true)).toBe("image");
    expect(planPathAttachment("C:\\a.png", false)).toBe("file");
    expect(planPathAttachment("C:\\a.md", true)).toBe("file");
  });
});
