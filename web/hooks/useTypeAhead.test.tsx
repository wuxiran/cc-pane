import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { matchTypeAhead, useRowTypeAhead } from "./useTypeAhead";

const LABELS = ["alpha", "beta", "bravo", "charlie"];

describe("matchTypeAhead", () => {
  it("匹配前缀且不区分大小写", () => {
    expect(matchTypeAhead(LABELS, "C", -1)).toBe(3);
    expect(matchTypeAhead(LABELS, "br", 0)).toBe(2);
  });

  it("单字符连按在匹配项之间循环", () => {
    expect(matchTypeAhead(LABELS, "b", 1)).toBe(2);
    expect(matchTypeAhead(LABELS, "bb", 2)).toBe(1);
  });

  it("继续输入时保持当前匹配", () => {
    expect(matchTypeAhead(LABELS, "be", 1)).toBe(1);
  });

  it("无匹配返回 -1", () => {
    expect(matchTypeAhead(LABELS, "z", 0)).toBe(-1);
    expect(matchTypeAhead([], "a", 0)).toBe(-1);
  });
});

function Fixture({ onInputKey }: { onInputKey?: () => void }) {
  const onKeyDown = useRowTypeAhead();
  return (
    <div onKeyDown={onKeyDown}>
      <input aria-label="search" onKeyDown={onInputKey} />
      {["apple", "banana"].map((name) => (
        <div key={name} tabIndex={0} data-typeahead-label={name} data-testid={name} />
      ))}
    </div>
  );
}

describe("useRowTypeAhead", () => {
  it("键入字母聚焦到匹配行", () => {
    render(<Fixture />);
    const rows = [screen.getByTestId("apple"), screen.getByTestId("banana")];
    rows.forEach((row) => { row.getClientRects = () => [{}] as unknown as DOMRectList; row.scrollIntoView = vi.fn(); });
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "b" });
    expect(document.activeElement).toBe(rows[1]);
  });

  it("修饰键、空格和输入框内不触发", () => {
    render(<Fixture />);
    const row = screen.getByTestId("apple");
    const banana = screen.getByTestId("banana");
    [row, banana].forEach((item) => { item.getClientRects = () => [{}] as unknown as DOMRectList; item.scrollIntoView = vi.fn(); });
    row.focus();
    fireEvent.keyDown(row, { key: "b", metaKey: true });
    fireEvent.keyDown(row, { key: " " });
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(screen.getByLabelText("search"), { key: "b" });
    expect(document.activeElement).toBe(row);
  });
});
