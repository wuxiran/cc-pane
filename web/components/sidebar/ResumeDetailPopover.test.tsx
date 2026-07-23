import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchRecord } from "@/services";
import ResumeDetailPopover from "./ResumeDetailPopover";

const openPathInExplorer = vi.fn(async (_path: string) => undefined);

vi.mock("@/services/providerService", () => ({
  providerService: {
    openPathInExplorer: (path: string) => openPathInExplorer(path),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

function createRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    id: 42,
    projectId: "proj-1",
    projectName: "My Project",
    projectPath: "D:/work/my-project",
    launchedAt: "2026-05-01T10:00:00Z",
    resumeSessionId: "abcdef012345678901234567",
    lastPrompt: "fix the build",
    ...overrides,
  };
}

function renderPopover(record: LaunchRecord) {
  const onResume = vi.fn();
  const onDelete = vi.fn();
  render(
    <ResumeDetailPopover record={record} onResume={onResume} onDelete={onDelete}>
      <button>trigger</button>
    </ResumeDetailPopover>,
  );
  return { onResume, onDelete };
}

describe("ResumeDetailPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  it("renders the trigger and opens the popover on click", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord());

    expect(screen.getByRole("button", { name: "trigger" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "trigger" }));

    expect(await screen.findByText("My Project")).toBeVisible();
    expect(screen.getByText("D:/work/my-project")).toBeVisible();
  });

  it("truncates a long session id in the middle", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord({ resumeSessionId: "abcdef012345678901234567" }));

    await user.click(screen.getByRole("button", { name: "trigger" }));

    expect(await screen.findByText("abcdef01...01234567")).toBeVisible();
  });

  it("shows the full session id when short", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord({ resumeSessionId: "short123" }));

    await user.click(screen.getByRole("button", { name: "trigger" }));

    expect(await screen.findByText("short123")).toBeVisible();
  });

  it("copies the session id and shows a success toast", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord({ resumeSessionId: "sess-xyz" }));

    await user.click(screen.getByRole("button", { name: "trigger" }));
    // The copy button is the small icon button next to the session id code
    const copyBtn = (await screen.findByText("sess-xyz")).parentElement!.querySelector("button")!;
    await user.click(copyBtn);

    expect(toast.success).toHaveBeenCalled();
  });

  it("calls onResume with the record when clicking Resume", async () => {
    const user = userEvent.setup();
    const { onResume } = renderPopover(createRecord());

    await user.click(screen.getByRole("button", { name: "trigger" }));
    await user.click(await screen.findByRole("button", { name: /Resume|恢复/i }));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("disables resume and explains the missing capture id", async () => {
    const user = userEvent.setup();
    const { onResume } = renderPopover(createRecord({ resumeSessionId: undefined }));

    await user.click(screen.getByRole("button", { name: "trigger" }));
    const resume = await screen.findByRole("button", { name: /Resume|恢复/i });

    expect(resume).toBeDisabled();
    expect(screen.getByText(/未捕获到恢复 ID|resume ID was not captured/i)).toBeVisible();
    await user.click(resume);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("calls onDelete with the record id when clicking Delete", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderPopover(createRecord({ id: 99 }));

    await user.click(screen.getByRole("button", { name: "trigger" }));
    await user.click(await screen.findByRole("button", { name: /Delete|删除/i }));

    expect(onDelete).toHaveBeenCalledWith(99);
  });

  it("opens the project folder in explorer under Tauri runtime", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord({ projectPath: "D:/work/target" }));

    await user.click(screen.getByRole("button", { name: "trigger" }));
    await user.click(await screen.findByRole("button", { name: /Open Folder|打开文件夹|文件夹/i }));

    expect(openPathInExplorer).toHaveBeenCalledWith("D:/work/target");
  });

  it("hides the last prompt section when the record has no prompt", async () => {
    const user = userEvent.setup();
    renderPopover(createRecord({ lastPrompt: undefined }));

    await user.click(screen.getByRole("button", { name: "trigger" }));
    await screen.findByText("My Project");

    expect(screen.queryByText(/Last Prompt|上次提示|最近提示/i)).not.toBeInTheDocument();
  });
});
