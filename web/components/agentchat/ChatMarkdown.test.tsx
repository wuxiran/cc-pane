// 聊天 markdown 的本地图片转换：mock 成非 Tauri 运行时，toAssetUrl 走 web
// 部署的 /api/fs/raw 形态，断言确定（与 MarkdownPreview.test 同一手法）。
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChatMarkdown, { normalizeWindowsLinkDestinations } from "./ChatMarkdown";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => false,
}));

const RAW_PREFIX = "/api/fs/raw?path=";

function imgSrc(markdown: string, cwd?: string): string | null {
  const { container } = render(<ChatMarkdown text={markdown} cwd={cwd} />);
  return container.querySelector("img")?.getAttribute("src") ?? null;
}

describe("normalizeWindowsLinkDestinations", () => {
  it("盘符反斜杠目的地规范成正斜杠（CommonMark 会吃掉反斜杠）", () => {
    expect(normalizeWindowsLinkDestinations("![s](C:\\shots\\a.png)")).toBe(
      "![s](C:/shots/a.png)",
    );
    expect(normalizeWindowsLinkDestinations("[f](<D:\\x\\b.md>)")).toBe("[f](D:/x/b.md)");
  });

  it("正斜杠 / 相对路径 / 普通文本不受影响", () => {
    expect(normalizeWindowsLinkDestinations("![s](C:/shots/a.png)")).toBe(
      "![s](C:/shots/a.png)",
    );
    expect(normalizeWindowsLinkDestinations("![s](img/a.png)")).toBe("![s](img/a.png)");
    expect(normalizeWindowsLinkDestinations("路径 C:\\a\\b.ts 写在正文里")).toBe(
      "路径 C:\\a\\b.ts 写在正文里",
    );
  });
});

describe("ChatMarkdown 本地图片路径转换", () => {
  it("Windows 反斜杠绝对路径转资产 URL", () => {
    expect(imgSrc("![s](C:\\shots\\a.png)")).toBe(
      RAW_PREFIX + encodeURIComponent("C:/shots/a.png"),
    );
  });

  it("相对路径以会话 cwd 为基准解析", () => {
    expect(imgSrc("![s](img/a.png)", "D:\\proj")).toBe(
      RAW_PREFIX + encodeURIComponent("D:/proj/img/a.png"),
    );
  });

  it("Unix 绝对路径也按本地文件处理", () => {
    expect(imgSrc("![s](/home/u/a.png)")).toBe(
      RAW_PREFIX + encodeURIComponent("/home/u/a.png"),
    );
  });

  it("http 与 data URL 保持默认行为", () => {
    expect(imgSrc("![s](https://x.com/a.png)")).toBe("https://x.com/a.png");
    expect(imgSrc("![s](data:image/png;base64,AA)")).toBe("data:image/png;base64,AA");
  });

  it("没有 cwd 时相对路径不转换", () => {
    expect(imgSrc("![s](img/a.png)")).toBe("img/a.png");
  });
});

describe("ChatMarkdown 行内代码图片路径预览", () => {
  it("行内代码里的 Windows 图片路径直接显示图片，路径仍可点击", () => {
    const { container } = render(
      <ChatMarkdown text={"生成完毕：`C:\\shots\\a.png`"} cwd="D:\\proj" onOpenFile={() => {}} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      RAW_PREFIX + encodeURIComponent("C:/shots/a.png"),
    );
    expect(container.querySelector("code")).not.toBeNull();
  });

  it("相对图片路径以 cwd 解析显示", () => {
    const { container } = render(<ChatMarkdown text={"`out/a.png`"} cwd="D:\\proj" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      RAW_PREFIX + encodeURIComponent("D:/proj/out/a.png"),
    );
  });

  it("非图片路径不渲染 img，保持可点击代码", () => {
    const { container } = render(
      <ChatMarkdown text={"`src/a.rs`"} cwd="D:\\proj" onOpenFile={() => {}} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
  });
});

describe("ChatMarkdown file navigation", () => {
  it("opens local Markdown images by keyboard and resolves their paths against the chat cwd", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(<ChatMarkdown text="![capture](out/result.png)" cwd="/work/project" onOpenFile={open} />);
    screen.getByRole("button", { name: "capture" }).focus();
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith("/work/project/out/result.png");
  });

  it("never routes remote or data image sources into the local editor", () => {
    const open = vi.fn();
    render(<ChatMarkdown text="![remote](https://example.com/a.png) ![inline](data:image/png;base64,AA==)" cwd="/work" onOpenFile={open} />);
    fireEvent.click(screen.getByRole("img", { name: "remote" }));
    fireEvent.click(screen.getByRole("img", { name: "inline" }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps linked images and code free from nested controls, and fences remain plain code", () => {
    const open = vi.fn();
    const { container } = render(<ChatMarkdown text={'[![capture](/tmp/a.png)](/tmp/a.png) [`readme.md`](readme.md)\n\n```\nsrc/a.rs\n```'} cwd="/work" onOpenFile={open} />);
    expect(container.querySelector("a button")).toBeNull();
    expect(container.querySelector("pre button")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    fireEvent.click(screen.getByRole("link", { name: "capture" }));
    expect(open).toHaveBeenCalledWith("/tmp/a.png", undefined);
  });

  it("makes inline file code keyboard-accessible and preserves line numbers", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(<ChatMarkdown text="See `src/main.ts:17`" cwd="/work" onOpenFile={open} />);
    screen.getByRole("button", { name: "src/main.ts:17" }).focus();
    await user.keyboard(" ");
    expect(open).toHaveBeenCalledWith("src/main.ts", 17);
  });
});
