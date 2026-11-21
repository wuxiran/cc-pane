import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SkillMarketEntry } from "@/types";
import SkillDiscoverSection from "./SkillDiscoverSection";

const entry = {
  id: "anthropics/skills:pdf",
  name: "pdf",
  description: "PDF tools",
  tags: [],
  version: "1",
  recommended: false,
  source: "anthropics",
  repo: "anthropics/skills",
  path: "skills/pdf",
  featured: false,
} as unknown as SkillMarketEntry;

const svc = vi.hoisted(() => ({
  listSkillMarketEntries: vi.fn(),
  listUserSkills: vi.fn(async () => []),
  listWorkspaceSkills: vi.fn(async () => []),
  searchSkillMarket: vi.fn(async () => []),
  describeSkillMarketEntry: vi.fn(async (item: unknown) => item),
  installSkillMarketEntry: vi.fn(async () => ({ name: "pdf" })),
  removeUserSkill: vi.fn(),
  deleteWorkspaceSkill: vi.fn(),
}));
vi.mock("@/services/skillService", () => ({ skillService: svc }));
vi.mock("@/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toastOk: vi.fn(),
  toastErr: vi.fn(),
}));

const tm = (key: string, opts?: Record<string, unknown>) => String(i18n.t(`skillMarket:${key}` as never, opts as never));

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockClear();
  svc.listSkillMarketEntries.mockResolvedValue([entry]);
});

describe("SkillDiscoverSection 安装目标（docs/110 批 5）", () => {
  it("没有当前工作空间时不显示目标选择，装到用户级", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider><SkillDiscoverSection onRemove={() => {}} /></TooltipProvider>);
    const card = await screen.findByTestId("skill-market-card");
    expect(screen.queryByTestId("skill-discover-target")).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: tm("install") }));
    await waitFor(() => expect(svc.installSkillMarketEntry).toHaveBeenCalledWith(entry, null));
  });

  it("选「工作空间」后装进当前工作空间并通知页面刷新", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(
      <TooltipProvider>
        <SkillDiscoverSection onRemove={() => {}} workspaceName="ws1" onWorkspaceChanged={changed} />
      </TooltipProvider>,
    );
    await screen.findByTestId("skill-market-card");
    await user.click(screen.getByRole("tab", { name: tm("installTarget.workspace", { name: "ws1" }) }));
    await waitFor(() => expect(svc.listWorkspaceSkills).toHaveBeenCalledWith("ws1"));
    // 切换目标会重新读目录，卡片重新挂载
    const card = await screen.findByTestId("skill-market-card");
    await user.click(within(card).getByRole("button", { name: tm("install") }));
    await waitFor(() => expect(svc.installSkillMarketEntry).toHaveBeenCalledWith(entry, "ws1"));
    expect(changed).toHaveBeenCalled();
  });
});
