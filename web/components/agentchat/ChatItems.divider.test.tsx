import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemView } from "./ChatItems";

describe("ItemView transcript divider", () => {
  it("renders divider notices as a separator and plain notices as text", () => {
    const { rerender } = render(
      <ItemView item={{ type: "notice", id: "d", at: 1, text: "以下为恢复后的新会话", divider: true }} onPlanToTodo={() => {}} />,
    );
    expect(screen.getByRole("separator")).toHaveTextContent("以下为恢复后的新会话");
    rerender(<ItemView item={{ type: "notice", id: "n", at: 1, text: "plain" }} onPlanToTodo={() => {}} />);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("plain")).toBeInTheDocument();
  });
});
