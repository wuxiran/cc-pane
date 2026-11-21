import "@/i18n";
import i18n from "i18next";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationDef, AutomationRun } from "@/types";
import AutomationsWorkspace from "./AutomationsWorkspace";
import { describeNextRun, describeSchedule } from "./automationDraft";

const service = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  saveAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomationNow: vi.fn(),
  listAutomationRuns: vi.fn(),
  listenAutomationsChanged: vi.fn(),
}));

vi.mock("@/services", () => ({
  automationService: service,
  listAcpEngines: vi.fn(async () => [{ id: "claude", label: "Claude", available: true }]),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const ts = (key: string, options?: Record<string, unknown>): string => i18n.t(`settings:automations.${key}` as never, options ?? {}) as string;

function def(overrides: Partial<AutomationDef>): AutomationDef {
  return {
    id: "a1",
    name: "Nightly tests",
    prompt: "Run the tests",
    cwd: "/repo",
    workspaceName: null,
    engineId: "claude",
    schedule: "0 9 * * *",
    enabled: true,
    graceMinutes: 10,
    timeoutMinutes: 30,
    autoApprove: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  service.listAutomations.mockResolvedValue([]);
  service.listAutomationRuns.mockResolvedValue([]);
  service.listenAutomationsChanged.mockResolvedValue(() => undefined);
  service.saveAutomation.mockImplementation(async (saved: AutomationDef) => ({ ...saved, id: saved.id || "new-id" }));
  service.deleteAutomation.mockResolvedValue(undefined);
});

describe("AutomationsWorkspace", () => {
  it("shows the template gallery when nothing is selected, and a template prefills the editor", async () => {
    const user = userEvent.setup();
    render(<AutomationsWorkspace />);

    const gallery = await screen.findByTestId("automation-template-gallery");
    expect(within(gallery).getByText(ts("heroTitle"))).toBeInTheDocument();

    await user.click(gallery.querySelector('[data-template-id="testPatrol"]') as HTMLElement);
    const editor = await screen.findByTestId("automation-editor");
    expect(within(editor).getByLabelText(ts("name"))).toHaveValue(ts("templates.testPatrol.title"));
    expect(within(editor).getByLabelText(ts("prompt"))).toHaveValue(ts("templates.testPatrol.prompt"));
  });

  it("groups tasks into enabled and paused, and shows the prompt and runs of the selected task", async () => {
    const user = userEvent.setup();
    const runs: AutomationRun[] = [
      { id: "r1", automationId: "a1", scheduledFor: 1, startedAt: 1_000, finishedAt: 6_000, status: "failed", detail: "boom" },
    ];
    service.listAutomations.mockResolvedValue([def({}), def({ id: "a2", name: "Paused job", enabled: false })]);
    service.listAutomationRuns.mockResolvedValue(runs);
    render(<AutomationsWorkspace />);

    const list = await screen.findByTestId("automation-task-list");
    const enabled = await within(list).findByRole("region", { name: ts("sectionEnabled") });
    const paused = within(list).getByRole("region", { name: ts("sectionPaused") });
    expect(within(enabled).getByText("Nightly tests")).toBeInTheDocument();
    expect(within(paused).getByText("Paused job")).toBeInTheDocument();

    await user.click(within(enabled).getByText("Nightly tests"));
    expect(await screen.findByTestId("automation-prompt-bubble")).toHaveTextContent("Run the tests");
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(service.listAutomationRuns).toHaveBeenCalledWith("a1");
  });

  it("asks for a second click before deleting", async () => {
    const user = userEvent.setup();
    service.listAutomations.mockResolvedValue([def({})]);
    render(<AutomationsWorkspace />);

    await user.click(await screen.findByText("Nightly tests"));
    const detail = await screen.findByTestId("automation-detail");
    await user.click(within(detail).getByRole("button", { name: ts("delete") }));
    expect(service.deleteAutomation).not.toHaveBeenCalled();
    await user.click(within(detail).getByRole("button", { name: ts("deleteConfirm") }));
    await waitFor(() => expect(service.deleteAutomation).toHaveBeenCalledWith("a1"));
    expect(await screen.findByTestId("automation-template-gallery")).toBeInTheDocument();
  });

  it("saves a new task and selects it", async () => {
    const user = userEvent.setup();
    render(<AutomationsWorkspace />);

    await user.click(await screen.findByRole("button", { name: ts("newTask") }));
    const editor = await screen.findByTestId("automation-editor");
    await user.type(within(editor).getByLabelText(ts("name")), "Mine");
    await user.type(within(editor).getByLabelText(ts("prompt")), "Do it");
    await user.type(within(editor).getByLabelText(ts("cwd")), "/repo");
    service.listAutomations.mockResolvedValue([def({ id: "new-id", name: "Mine", prompt: "Do it" })]);
    await user.click(within(editor).getByRole("button", { name: ts("save") }));

    await waitFor(() => expect(service.saveAutomation).toHaveBeenCalled());
    expect(service.saveAutomation.mock.calls[0][0]).toMatchObject({ name: "Mine", prompt: "Do it", cwd: "/repo", schedule: "0 9 * * *" });
    expect(await screen.findByTestId("automation-prompt-bubble")).toHaveTextContent("Do it");
  });
});

describe("schedule wording", () => {
  const t = i18n.getFixedT(null, "settings");

  it("describes presets in plain words and falls back to the raw cron", () => {
    expect(describeSchedule("0 * * * *", t, "en")).toBe(t("automations.preset.hourly"));
    expect(describeSchedule("30 8 * * *", t, "en")).toBe(`${t("automations.preset.daily")} 08:30`);
    expect(describeSchedule("*/5 * * * *", t, "en")).toBe("*/5 * * * *");
  });

  it("says today / tomorrow for near runs", () => {
    const now = new Date(2026, 10, 20, 8, 0);
    expect(describeNextRun(new Date(2026, 10, 20, 9, 0).getTime(), t, "en", now)).toMatch(/^Today|^今天/);
    expect(describeNextRun(new Date(2026, 10, 21, 9, 0).getTime(), t, "en", now)).toMatch(/^Tomorrow|^明天/);
    expect(describeNextRun(null, t, "en", now)).toBe("—");
  });
});
