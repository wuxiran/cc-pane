import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";
import { EmptyBoxIllustration } from "./empty-illustrations";

describe("EmptyState", () => {
  it("renders title, description and the icon chip by default (no illustration)", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="暂无内容" description="稍后再来看看" />,
    );

    expect(screen.getByText("暂无内容")).toBeInTheDocument();
    expect(screen.getByText("稍后再来看看")).toBeInTheDocument();
    // 默认形态：无插画 svg，保留图标 chip
    expect(container.querySelector("svg[data-illustration]")).not.toBeInTheDocument();
    expect(container.querySelector("svg.lucide")).toBeInTheDocument();
  });

  it("renders the action button and wires onClick", () => {
    const onClick = vi.fn();
    render(
      <EmptyState icon={Inbox} title="空" action={{ label: "新建", onClick }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders an illustration by semantic name in place of the icon chip", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="没有结果" illustration="empty-search" />,
    );

    const svg = container.querySelector("svg[data-illustration='empty-search']");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    // 插画在上、标题在下
    expect(svg?.compareDocumentPosition(screen.getByText("没有结果"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // 图标 chip 不再渲染
    expect(container.querySelector("svg.lucide")).not.toBeInTheDocument();
  });

  it("accepts an illustration component directly", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="空列表" illustration={EmptyBoxIllustration} />,
    );

    expect(
      container.querySelector("svg[data-illustration='empty-box']"),
    ).toBeInTheDocument();
  });

  it("merges custom className on the root", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="空" className="py-24" />,
    );

    expect(container.firstElementChild).toHaveClass("py-24");
  });

  it("passes accent classes through to the illustration without changing defaults", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="空" illustration="empty-box" accent="h-24 w-24" />,
    );

    const svg = container.querySelector("svg[data-illustration='empty-box']");
    expect(svg).toHaveClass("h-24", "w-24");
    expect(svg).not.toHaveClass("h-20");
  });

  it("keeps the default 80px illustration size when accent is omitted", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="空" illustration="empty-box" />,
    );

    const svg = container.querySelector("svg[data-illustration='empty-box']");
    expect(svg).toHaveClass("h-20", "w-20");
  });
});
