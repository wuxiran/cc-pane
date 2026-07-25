import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownPreview from "./MarkdownPreview";

// mermaid 体积大且依赖真实 DOM 测量，测试中桩掉动态 import
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' })),
  },
}));

// 非 Tauri 环境走 /api/fs/raw 资产 URL
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => false,
}));

describe("MarkdownPreview", () => {
  it("renders headings from markdown", () => {
    render(<MarkdownPreview content={"# Hello\n\nSome paragraph"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("Some paragraph")).toBeInTheDocument();
  });

  it("supports GFM extensions such as strikethrough and tables", () => {
    const { container } = render(
      <MarkdownPreview content={"~~gone~~\n\n| a | b |\n| - | - |\n| 1 | 2 |"} />
    );
    expect(container.querySelector("del")).toHaveTextContent("gone");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders empty content without crashing", () => {
    const { container } = render(<MarkdownPreview content="" />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("对显式语言代码块输出 hljs 高亮 token", () => {
    const md = '```ts\nconst x = "hi";\n```';
    const { container } = render(<MarkdownPreview content={md} />);

    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".hljs-string").length).toBeGreaterThan(0);
  });

  it("无语言标注的代码块不做猜测高亮", () => {
    const { container } = render(<MarkdownPreview content={"```\nplain block\n```"} />);

    expect(container.querySelector("code")).toBeTruthy();
    expect(container.querySelectorAll("[class*='hljs-']").length).toBe(0);
  });

  it("mermaid 代码块渲染为图（懒加载 mermaid）", async () => {
    const { container } = render(
      <MarkdownPreview content={"```mermaid\ngraph TD; A-->B;\n```"} />,
    );

    await waitFor(() => expect(container.querySelector(".mermaid-diagram")).toBeTruthy());
    expect(container.querySelector("pre")).toBeNull();
  });

  it("相对图片路径按 md 文件目录解析为资产 URL", () => {
    const { container } = render(
      <MarkdownPreview content="![p](img/a.png)" filePath="D:/docs/readme.md" />,
    );

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      `/api/fs/raw?path=${encodeURIComponent("D:/docs/img/a.png")}`,
    );
  });

  it("http 图片与无 filePath 时不做本地转换", () => {
    const { container } = render(
      <MarkdownPreview content="![p](https://x.com/a.png)" filePath="D:/docs/readme.md" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x.com/a.png");
  });

  it("滚动时回调容器元素（供分栏同步）", () => {
    const onScroll = vi.fn();
    const { container } = render(<MarkdownPreview content="# t" onScroll={onScroll} />);

    fireEvent.scroll(container.firstElementChild!);

    expect(onScroll).toHaveBeenCalledWith(container.firstElementChild);
  });
});
