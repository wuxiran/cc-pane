import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CompactStartIntro, { recentForProject } from "./CompactStartIntro";

const entry = (acpSessionId: string, cwd: string, updatedAt: number) =>
  ({ acpSessionId, engineId: "claude", cwd, title: `t-${acpSessionId}`, createdAt: 0, updatedAt });

describe("CompactStartIntro", () => {
  it("只列本项目最近 3 条，按更新时间倒序", () => {
    const entries = [entry("a", "/repo", 1), entry("b", "/other", 9), entry("c", "/repo/", 5), entry("d", "/repo", 3), entry("e", "/repo", 4)];
    expect(recentForProject(entries, "/repo").map((item) => item.acpSessionId)).toEqual(["c", "e", "d"]);
  });

  it("点建议把提示词交给输入框，点最近对话续接", async () => {
    const user = userEvent.setup();
    const onSuggest = vi.fn();
    const onResume = vi.fn();
    render(<CompactStartIntro projectName="cc-pane" cwd="/repo" entries={[entry("a", "/repo", 1)]} disabled={false} onSuggest={onSuggest} onResume={onResume} />);

    expect(screen.getByText("cc-pane")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button")[0]);
    expect(onSuggest).toHaveBeenCalledWith(expect.any(String));
    await user.click(screen.getByTestId("compact-recent-session"));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ acpSessionId: "a" }));
  });
});
