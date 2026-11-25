import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useComposerSuggestions } from "./useComposerSuggestions";

const fsMock = vi.hoisted(() => ({ searchProjectFiles: vi.fn() }));
const skillMock = vi.hoisted(() => ({ listProjectSkills: vi.fn(), listUserSkills: vi.fn() }));
vi.mock("@/services/filesystemService", () => ({ filesystemService: fsMock }));
vi.mock("@/services/skillService", () => ({ skillService: skillMock }));

const commands = [{ name: "review", description: "Review code" }, { name: "deploy-check" }];

function run(draft: string, availableCommands = commands) {
  return renderHook(() => useComposerSuggestions({ draft, cwd: "/repo", availableCommands }));
}

describe("useComposerSuggestions", () => {
  beforeEach(() => {
    fsMock.searchProjectFiles.mockReset();
    skillMock.listProjectSkills.mockReset();
    skillMock.listUserSkills.mockReset();
  });

  it("`/` 开头按前缀列出 agent 命令", () => {
    const { result } = run("/re");
    expect(result.current.items.map((item) => item.nextDraft)).toEqual(["/review "]);
  });

  it("`@` 搜索项目文件，选中后替换末尾的 @query 并保留前文", async () => {
    fsMock.searchProjectFiles.mockResolvedValue({ paths: ["web/app/main.tsx"], truncated: false });
    const { result } = run("看看 @mai");
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(fsMock.searchProjectFiles).toHaveBeenCalledWith("/repo", "mai", 8);
    expect(result.current.items[0]).toMatchObject({
      kind: "file",
      label: "main.tsx",
      nextDraft: "看看 @web/app/main.tsx ",
    });
  });

  it("`@` 搜索失败（如远端会话）时没有候选，只留提示", async () => {
    fsMock.searchProjectFiles.mockRejectedValue(new Error("not found"));
    const { result } = run("@x");
    await waitFor(() => expect(fsMock.searchProjectFiles).toHaveBeenCalled());
    expect(result.current.items).toEqual([]);
    expect(result.current.mentionPending).toBe("x");
  });

  it("`$` 合并项目与用户技能（同名去重），agent 有同名命令且位于开头时改用 /name", async () => {
    skillMock.listProjectSkills.mockResolvedValue([{ name: "review", description: "项目版" }]);
    skillMock.listUserSkills.mockResolvedValue([
      { name: "review", description: "用户版" },
      { name: "gen-image", description: "生成图片" },
    ]);
    const atStart = run("$");
    await waitFor(() => expect(atStart.result.current.items).toHaveLength(2));
    expect(atStart.result.current.items.map((item) => [item.label, item.detail, item.nextDraft])).toEqual([
      ["$gen-image", "生成图片", "$gen-image "],
      ["$review", "项目版", "/review "],
    ]);

    const midSentence = run("先 $rev");
    await waitFor(() => expect(midSentence.result.current.items).toHaveLength(1));
    expect(midSentence.result.current.items[0].nextDraft).toBe("先 $review ");
  });

  it("普通文本不出菜单", () => {
    const { result } = run("hello world");
    expect(result.current.items).toEqual([]);
    expect(fsMock.searchProjectFiles).not.toHaveBeenCalled();
  });
});
