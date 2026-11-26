import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemView } from "./ChatItems";

describe("ItemView notice dividers", () => {
  it("renders divider notices as a separator and plain notices as text", () => {
    const { rerender } = render(
      <ItemView item={{ type: "notice", id: "d", at: 1, text: "以下为恢复后的新会话", divider: true }} onPlanToTodo={() => {}} />,
    );
    expect(screen.getByRole("separator")).toHaveTextContent("以下为恢复后的新会话");
    rerender(<ItemView item={{ type: "notice", id: "n", at: 1, text: "plain" }} onPlanToTodo={() => {}} />);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("plain")).toBeInTheDocument();
  });

  it("renders the handoff separator with both engines and brand icons", () => {
    render(
      <ItemView
        item={{ type: "notice", id: "h", at: 1, text: "handoff", handoff: { from: "Claude · Sonnet", to: "Codex", fromEngineId: "claude", toEngineId: "acp-registry-x" } }}
        onPlanToTodo={() => {}}
      />,
    );
    const divider = screen.getByTestId("chat-handoff-divider");
    expect(divider).toHaveAttribute("role", "separator");
    expect(screen.getByTestId("chat-handoff-from")).toHaveTextContent("Claude · Sonnet");
    expect(screen.getByTestId("chat-handoff-to")).toHaveTextContent("Codex");
    expect(divider.querySelector('[data-cli-brand="claude"]')).not.toBeNull();
    expect(divider.querySelector('[data-engine-generic="acp-registry-x"]')).not.toBeNull();
    expect(screen.queryByTestId("chat-transcript-divider")).toBeNull();
  });
});
