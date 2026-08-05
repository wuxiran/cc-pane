import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CollapsibleCheckGroup } from "./CollapsibleCheckGroup";

function renderGroup(props: Partial<React.ComponentProps<typeof CollapsibleCheckGroup>> = {}) {
  return render(
    <CollapsibleCheckGroup
      title="Skills"
      total={12}
      enabledCount={3}
      formatCount={(total, enabled) => `${total} 项 · 启用 ${enabled}`}
      {...props}
    >
      <div>row-content</div>
    </CollapsibleCheckGroup>,
  );
}

describe("CollapsibleCheckGroup", () => {
  it("collapses long groups by default and expands on click", async () => {
    const user = userEvent.setup();
    renderGroup();

    expect(screen.queryByText("row-content")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("row-content")).toBeInTheDocument();
  });

  it("stays flat without collapse affordance when under the threshold", () => {
    renderGroup({ total: 4 });

    expect(screen.getByText("row-content")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("force-opens regardless of the collapsed state (search hit)", () => {
    renderGroup({ forceOpen: true });

    expect(screen.getByText("row-content")).toBeInTheDocument();
  });

  it("repeats the count under the scroll area once expanded", () => {
    renderGroup({ forceOpen: true });

    // 滚动区会截断视野，底部复述计数——组头 + 组底共两处
    expect(screen.getAllByText("12 项 · 启用 3")).toHaveLength(2);
  });
});
