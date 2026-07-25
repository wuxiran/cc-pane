import { describe, expect, it } from "vitest";
import { isLocalAssetPath, resolveRelativeAssetPath } from "./mdAssetPath";

describe("resolveRelativeAssetPath", () => {
  it("解析同级与子目录相对路径（Windows 基路径）", () => {
    expect(resolveRelativeAssetPath("D:/docs/readme.md", "img/a.png")).toBe("D:/docs/img/a.png");
    expect(resolveRelativeAssetPath("D:\\docs\\readme.md", "./a.png")).toBe("D:/docs/a.png");
  });

  it("解析 ../ 且不越过盘符", () => {
    expect(resolveRelativeAssetPath("D:/docs/sub/x.md", "../img/a.png")).toBe("D:/docs/img/a.png");
    expect(resolveRelativeAssetPath("D:/x.md", "../../a.png")).toBe("a.png");
  });

  it("保留 Unix 绝对根", () => {
    expect(resolveRelativeAssetPath("/home/u/doc.md", "../pic.png")).toBe("/home/pic.png");
  });
});

describe("isLocalAssetPath", () => {
  it("识别 Windows 盘符绝对路径与相对路径", () => {
    expect(isLocalAssetPath("D:/a/b.png")).toBe("windows-abs");
    expect(isLocalAssetPath("C:\\a.png")).toBe("windows-abs");
    expect(isLocalAssetPath("img/a.png")).toBe("relative");
    expect(isLocalAssetPath("./a.png")).toBe("relative");
  });

  it("真 scheme / 站内绝对 / 锚点不做本地解析", () => {
    expect(isLocalAssetPath("https://x.com/a.png")).toBeNull();
    expect(isLocalAssetPath("data:image/png;base64,xx")).toBeNull();
    expect(isLocalAssetPath("/api/x.png")).toBeNull();
    expect(isLocalAssetPath("#anchor")).toBeNull();
  });
});
