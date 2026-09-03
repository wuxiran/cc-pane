import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DramaShot } from "@/types/drama";
import DramaEpisodeEditor, { type DramaEpisodeEditorProps } from "./DramaEpisodeEditor";

const shot = { id: "s1", ordinal: 0, title: "开场", dialogue: "", prompt: "a street", imageRunId: "r1", videoRunId: null } as unknown as DramaShot;

function renderEditor(patch: Partial<DramaEpisodeEditorProps> = {}) {
  const props: DramaEpisodeEditorProps = {
    screenplayDraft: "第一场……",
    onScreenplayChange: vi.fn(),
    onScreenplayBlur: vi.fn(),
    llmProviders: [{ id: "p1", name: "GPT" }, { id: "p2", name: "Claude" }],
    splitProviderId: "p1",
    onSplitProviderChange: vi.fn(),
    splitting: false,
    onSplit: vi.fn(),
    shots: [shot],
    generating: false,
    batchTargets: [shot],
    restyleEligible: [shot],
    previews: { r1: "blob:img" },
    selectedShotIds: {},
    onToggleShot: vi.fn(),
    runStatusLabel: (runId) => (runId ? "done" : "none"),
    onAddShot: vi.fn(),
    onBatchImages: vi.fn(),
    onBatchVideos: vi.fn(),
    onOpenRestyle: vi.fn(),
    onGenerateImage: vi.fn(),
    onGenerateVideo: vi.fn(),
    onPatchShot: vi.fn(),
    onRemoveShot: vi.fn(),
    ...patch,
  };
  render(<DramaEpisodeEditor {...props} />);
  return props;
}

describe("DramaEpisodeEditor", () => {
  it("剧本编辑、拆分镜与批量按钮回传父组件", async () => {
    const user = userEvent.setup();
    const props = renderEditor();
    fireEvent.change(screen.getByTestId("drama-screenplay"), { target: { value: "改" } });
    expect(props.onScreenplayChange).toHaveBeenCalledWith("改");
    fireEvent.blur(screen.getByTestId("drama-screenplay"));
    expect(props.onScreenplayBlur).toHaveBeenCalled();

    await user.click(screen.getByTestId("drama-split-shots"));
    await user.click(screen.getByTestId("drama-batch-images"));
    await user.click(screen.getByTestId("drama-batch-videos"));
    await user.click(screen.getByTestId("drama-batch-restyle"));
    expect(props.onSplit).toHaveBeenCalled();
    expect(props.onBatchImages).toHaveBeenCalled();
    expect(props.onBatchVideos).toHaveBeenCalled();
    expect(props.onOpenRestyle).toHaveBeenCalled();
  });

  it("分镜行：勾选、改标题失焦、生图/生视频/删除", async () => {
    const user = userEvent.setup();
    const props = renderEditor();
    const row = screen.getByTestId("drama-shot-s1");
    await user.click(row.querySelector("input[type=checkbox]")!);
    expect(props.onToggleShot).toHaveBeenCalledWith("s1", true);

    const title = screen.getByDisplayValue("开场");
    fireEvent.change(title, { target: { value: "开场 v2" } });
    fireEvent.blur(title);
    expect(props.onPatchShot).toHaveBeenCalledWith(shot, { title: "开场 v2" });

    const buttons = row.querySelectorAll("button");
    await user.click(buttons[buttons.length - 3]);
    await user.click(buttons[buttons.length - 2]);
    await user.click(buttons[buttons.length - 1]);
    expect(props.onGenerateImage).toHaveBeenCalledWith(shot, 0);
    expect(props.onGenerateVideo).toHaveBeenCalledWith(shot, 0);
    expect(props.onRemoveShot).toHaveBeenCalledWith(shot);
    expect(row.querySelector("img")?.getAttribute("src")).toBe("blob:img");
  });

  it("拆分中禁用按钮；无分镜时显示空态", () => {
    renderEditor({ splitting: true, shots: [], batchTargets: [], restyleEligible: [] });
    expect(screen.getByTestId("drama-split-shots")).toBeDisabled();
    expect(screen.getByTestId("drama-batch-images")).toBeDisabled();
    expect(screen.queryByTestId("drama-shot-s1")).not.toBeInTheDocument();
  });
});
