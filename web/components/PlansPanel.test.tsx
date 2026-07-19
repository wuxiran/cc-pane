import i18n from "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlansPanel from "./PlansPanel";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { PlanEntry } from "@/services";

const noArchivedPlans = String(i18n.t("sidebar:noArchivedPlans"));
const searchPlaceholder = String(i18n.t("common:search"));

const PROJECT_PATH = "C:/repos/myproj";

const PLAN1: PlanEntry = {
  fileName: "p1.md",
  originalName: "Refactor Plan",
  sessionId: "sess-aaa",
  archivedAt: "2026-01-02T10:20:00.000Z",
  size: 2048,
};
const PLAN2: PlanEntry = {
  fileName: "p2.md",
  originalName: "Auth Plan",
  sessionId: "sess-bbb",
  archivedAt: "2026-01-03T11:30:00.000Z",
  size: 500,
};

/** 默认成功桩：list/get/delete */
function stubPlans(plans: PlanEntry[] = [PLAN1, PLAN2]) {
  mockTauriInvoke({
    list_plans: () => plans,
    get_plan_content: (_cmd: string, args?: Record<string, unknown>) =>
      (args?.fileName === "p2.md" ? "# Auth content" : "# Refactor content"),
    delete_plan: () => undefined,
  });
}

function renderPanel(open = true) {
  const onOpenChange = vi.fn();
  render(<PlansPanel open={open} onOpenChange={onOpenChange} projectPath={PROJECT_PATH} />);
  return { onOpenChange };
}

describe("PlansPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("open=false 时不渲染面板标题", () => {
    stubPlans();
    renderPanel(false);
    expect(screen.queryByText(/Plan 归档|Plan Archive/i)).not.toBeInTheDocument();
  });

  it("打开后加载列表并在标题追加项目名", async () => {
    stubPlans();
    renderPanel();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_plans", { projectPath: PROJECT_PATH }));
    expect(await screen.findByText(/Plan 归档.*myproj|Plan Archive.*myproj/i)).toBeInTheDocument();
    expect(await screen.findByText("Refactor Plan")).toBeInTheDocument();
    expect(screen.getByText("Auth Plan")).toBeInTheDocument();
  });

  it("空列表时显示无归档提示", async () => {
    stubPlans([]);
    renderPanel();
    expect(await screen.findByText(noArchivedPlans)).toBeInTheDocument();
  });

  it("默认自动选中并加载第一个计划的内容", async () => {
    stubPlans();
    renderPanel();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_plan_content", {
        projectPath: PROJECT_PATH,
        fileName: "p1.md",
      }),
    );
    expect(await screen.findByText("# Refactor content")).toBeInTheDocument();
  });

  it("点击其它计划切换并加载对应内容", async () => {
    const user = userEvent.setup();
    stubPlans();
    renderPanel();
    await screen.findByText("Auth Plan");

    await user.click(screen.getByText("Auth Plan"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_plan_content", {
        projectPath: PROJECT_PATH,
        fileName: "p2.md",
      }),
    );
    expect(await screen.findByText("# Auth content")).toBeInTheDocument();
  });

  it("搜索按名称过滤列表", async () => {
    const user = userEvent.setup();
    stubPlans();
    renderPanel();
    await screen.findByText("Refactor Plan");

    await user.type(screen.getByPlaceholderText(searchPlaceholder), "auth");

    expect(screen.queryByText("Refactor Plan")).not.toBeInTheDocument();
    expect(screen.getByText("Auth Plan")).toBeInTheDocument();
  });

  it("搜索无匹配时显示 No matches", async () => {
    const user = userEvent.setup();
    stubPlans();
    renderPanel();
    await screen.findByText("Refactor Plan");

    await user.type(screen.getByPlaceholderText(searchPlaceholder), "zzzz-none");

    expect(await screen.findByText(/No matches/i)).toBeInTheDocument();
  });

  it("删除计划调用 delete_plan 并从列表移除", async () => {
    const user = userEvent.setup();
    stubPlans();
    renderPanel();
    const authRow = (await screen.findByText("Auth Plan")).closest(".group") as HTMLElement;

    await user.click(within(authRow).getByRole("button"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_plan", {
        projectPath: PROJECT_PATH,
        fileName: "p2.md",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Auth Plan")).not.toBeInTheDocument());
  });

  it("列表加载失败时静默降级为无归档提示", async () => {
    mockTauriInvoke({
      list_plans: () => Promise.reject(new Error("boom")),
    });
    renderPanel();
    expect(await screen.findByText(noArchivedPlans)).toBeInTheDocument();
  });
});
