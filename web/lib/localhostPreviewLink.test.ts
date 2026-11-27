import { describe, expect, it } from "vitest";
import { findLocalhostPreviewLinks, localPreviewUrl, parseLocalhostPreviewUrl } from "./localhostPreviewLink";

describe("findLocalhostPreviewLinks", () => {
  it("识别 Vite / Next 风格的地址行", () => {
    const [vite] = findLocalhostPreviewLinks("  ➜  Local:   http://localhost:5173/");
    expect(vite).toMatchObject({ scheme: "http", remoteHost: "localhost", port: 5173, path: "/", text: "http://localhost:5173/" });
    const [next] = findLocalhostPreviewLinks("- Local: https://127.0.0.1:3000/app?x=1.");
    expect(next).toMatchObject({ scheme: "https", remoteHost: "127.0.0.1", port: 3000, path: "/app?x=1" });
  });

  it("裸 host:port、0.0.0.0 与 [::1]", () => {
    expect(findLocalhostPreviewLinks("listening on localhost:8080")[0]).toMatchObject({ port: 8080, path: "", scheme: "http" });
    expect(findLocalhostPreviewLinks("bound 0.0.0.0:4000,")[0]).toMatchObject({ remoteHost: "127.0.0.1", port: 4000, text: "0.0.0.0:4000" });
    expect(findLocalhostPreviewLinks("at http://[::1]:9229/json")[0]).toMatchObject({ remoteHost: "::1", port: 9229, path: "/json" });
  });

  it("下标与原文对齐，一行多个", () => {
    const text = "api localhost:3001 web (http://localhost:3000)";
    const links = findLocalhostPreviewLinks(text);
    expect(links.map((link) => text.slice(link.startIndex, link.endIndex))).toEqual([
      "localhost:3001",
      "http://localhost:3000",
    ]);
  });

  it("不是本机回环或端口非法的都不算", () => {
    for (const text of [
      "foo.localhost:3000",
      "user@localhost:22",
      "http://example.com:3000",
      "localhost:0",
      "localhost:70000",
      "localhost:3000abc",
      "127.0.0.10:80",
      "my-localhost:80",
    ]) {
      expect(findLocalhostPreviewLinks(text), text).toEqual([]);
    }
  });

  it("OSC 8 URL 必须整体是回环地址", () => {
    expect(parseLocalhostPreviewUrl("http://localhost:3000/docs")).toMatchObject({ port: 3000, path: "/docs" });
    expect(parseLocalhostPreviewUrl("http://localhost:3000.example.com/")).toBeNull();
    expect(parseLocalhostPreviewUrl("https://github.com")).toBeNull();
  });

  it("本机地址用 127.0.0.1 + 分配到的端口", () => {
    expect(localPreviewUrl({ scheme: "http", path: "" }, 41234)).toBe("http://127.0.0.1:41234/");
    expect(localPreviewUrl({ scheme: "https", path: "/a?b" }, 3000)).toBe("https://127.0.0.1:3000/a?b");
  });
});
