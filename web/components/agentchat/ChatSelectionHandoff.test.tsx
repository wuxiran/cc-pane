import "@/i18n";
import i18n from "i18next";
import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatSelectionHandoff from "./ChatSelectionHandoff";
import { useTranscriptSelection } from "./useTranscriptSelection";

function Harness({ onHandoff, onMenu }: { onHandoff: (text: string) => void; onMenu?: (text: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const selection = useTranscriptSelection(ref, true);
  return <div style={{ position: "relative" }}>
    <div ref={ref} data-testid="transcript"><p>Agent reply to hand off</p></div>
    <p data-testid="outside">Outside text</p>
    <button type="button" aria-haspopup="menu" onClick={() => onMenu?.(selection.captureForMenu())}>More</button>
    <ChatSelectionHandoff anchor={selection.anchor} onHandoff={(text) => { selection.dismiss(); onHandoff(text); }} />
  </div>;
}

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const current = window.getSelection()!;
  current.removeAllRanges(); current.addRange(range);
}

async function settle() {
  fireEvent.mouseUp(document);
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

beforeEach(async () => { await i18n.changeLanguage("en"); window.getSelection()?.removeAllRanges(); });

describe("transcript selection handoff", () => {
  it("floats a handoff action for text selected in the transcript", async () => {
    const onHandoff = vi.fn();
    render(<Harness onHandoff={onHandoff} />);
    select(screen.getByText("Agent reply to hand off"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Hand off to Codex desktop" }));
    expect(onHandoff).toHaveBeenCalledWith("Agent reply to hand off");
    expect(screen.queryByTestId("chat-selection-handoff")).not.toBeInTheDocument();
  });

  it("ignores selections outside the transcript", async () => {
    render(<Harness onHandoff={vi.fn()} />);
    select(screen.getByTestId("outside"));
    await settle();
    expect(screen.queryByTestId("chat-selection-handoff")).not.toBeInTheDocument();
  });

  it("keeps the selection captured when the menu trigger steals it", async () => {
    const onMenu = vi.fn();
    render(<Harness onHandoff={vi.fn()} onMenu={onMenu} />);
    select(screen.getByText("Agent reply to hand off"));
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.pointerDown(trigger);
    window.getSelection()?.removeAllRanges();
    fireEvent.click(trigger);
    expect(onMenu).toHaveBeenCalledWith("Agent reply to hand off");
  });

  it("does not reuse a stale selection after clicking elsewhere", () => {
    const onMenu = vi.fn();
    render(<Harness onHandoff={vi.fn()} onMenu={onMenu} />);
    select(screen.getByText("Agent reply to hand off"));
    fireEvent.pointerDown(screen.getByTestId("outside"));
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(onMenu).toHaveBeenCalledWith("");
  });
});
