import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfileDraft } from "@/types";
import type { LibrarySkill } from "@/types/skillLibrary";
import { isUserSkillSelected } from "./launchProfileHelpers";
import LaunchProfileSkillAdd from "./LaunchProfileSkillAdd";

const openResourceLibrary = vi.fn();
vi.mock("@/stores/useResourceLibraryStore", () => ({ openResourceLibrary: (...args: unknown[]) => openResourceLibrary(...args) }));

const tr = (key: string) => String(i18n.t(`providers:${key}` as never));

const librarySkill = {
  id: "s1",
  name: "review-guard",
  description: "Review before merge",
  folderMissing: false,
} as unknown as LibrarySkill;

beforeEach(() => {
  openResourceLibrary.mockReset();
  useSkillLibraryStore.setState({ skills: [librarySkill], loaded: true, load: async () => {} });
});

function setup(draft: LaunchProfileDraft = defaultLaunchProfileDraft()) {
  const setDraft = vi.fn();
  const onHandwrite = vi.fn();
  render(<LaunchProfileSkillAdd draft={draft} setDraft={setDraft} onHandwrite={onHandwrite} />);
  fireEvent.click(screen.getByTestId("skill-add-trigger"));
  return { setDraft, onHandwrite, draft };
}

describe("LaunchProfileSkillAdd", () => {
  it("新增默认是从资源库已安装 / 内置技能里挑", () => {
    setup();
    expect(screen.getByTestId("skill-add")).toHaveTextContent("review-guard");
    expect(screen.getByTestId("skill-add")).toHaveTextContent("ccpanes-admin");
  });

  it("勾选资源库技能把它开给当前配置", () => {
    const { setDraft, draft } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "review-guard" }));
    const updater = setDraft.mock.calls[0][0] as (d: LaunchProfileDraft) => LaunchProfileDraft;
    expect(isUserSkillSelected(updater(draft).skillPolicy, "s1")).toBe(true);
  });

  it("手写是次要动作，点了才打开编辑器", () => {
    const { onHandwrite } = setup();
    fireEvent.click(screen.getByTestId("skill-add-handwrite"));
    expect(onHandwrite).toHaveBeenCalledTimes(1);
  });

  it("可以跳去技能市场", () => {
    setup();
    fireEvent.click(screen.getByTestId("skill-add-market"));
    expect(openResourceLibrary).toHaveBeenCalledWith("skills");
  });

  it("Skill 不注入时给出说明且不可勾选", () => {
    const base = defaultLaunchProfileDraft();
    setup({ ...base, skillPolicy: { ...base.skillPolicy, mode: "disabled" } });
    expect(screen.getByTestId("skill-add")).toHaveTextContent(tr("profileAdd.skillDisabled"));
    expect(screen.getByRole("checkbox", { name: "review-guard" })).toBeDisabled();
  });
});
