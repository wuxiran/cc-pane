import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { LaunchRecord } from "@/services";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: { tool?: string }) => (opts?.tool ? `${key}:${opts.tool}` : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("./emptyStateShared", () => ({
  CliIcon: () => <span />,
}));

import { LaunchMethodItems, latestLaunchFor, pickProjectMethods } from "./launchMethods";
import { useDialogStore } from "@/stores";

function rec(id: number, projectPath: string, cliTool: string | undefined, runtimeKind?: string): LaunchRecord {
  return {
    id,
    projectPath,
    projectName: projectPath.split("/").pop() ?? projectPath,
    cliTool,
    runtimeKind,
    launchedAt: new Date(2026, 10, 24 - id).toISOString(),
  } as unknown as LaunchRecord;
}

const Item = ({ children, onSelect, className }: { children?: ReactNode; onSelect?: (e: Event) => void; className?: string }) => (
  <button type="button" className={className} onClick={() => onSelect?.(new Event("select"))}>{children}</button>
);
const Separator = () => <hr />;

describe("launchMethods", () => {
  beforeEach(() => useDialogStore.setState({ pendingLaunch: null } as never));

  it("latestLaunchFor：大小写不敏感，取最新一条", () => {
    const records = [rec(1, "/A/proj", "claude"), rec(2, "/a/proj", "codex")];
    expect(latestLaunchFor(records, "/a/PROJ")?.id).toBe(1);
    expect(latestLaunchFor(records, "/other")).toBeNull();
  });

  it("pickProjectMethods：按 CLI×环境去重，跳过纯终端", () => {
    const records = [
      rec(1, "/p", "claude"),
      rec(2, "/p", "claude"),
      rec(3, "/p", "codex", "wsl"),
      rec(4, "/p", "none"),
    ];
    expect(pickProjectMethods(records, "/p").map((r) => r.id)).toEqual([1, 3]);
  });

  it("菜单：终端置顶 + 历史方式 + 未用过的 CLI 兜底；选中即发起 pendingLaunch", () => {
    const records = [rec(1, "/p", "claude")];
    render(<LaunchMethodItems record={records[0]} records={records} Item={Item} Separator={Separator} />);

    expect(screen.getByText("recentLaunchTerminalOnly")).toBeInTheDocument();
    // 用过 claude → 不再给 claude 兜底项，只剩历史项；codex 没用过 → 兜底
    expect(screen.getAllByText("recentLaunchWithClaude")).toHaveLength(1);
    expect(screen.getByText("recentLaunchWithCodex")).toBeInTheDocument();

    fireEvent.click(screen.getByText("recentLaunchWithCodex"));
    expect(useDialogStore.getState().pendingLaunch).toMatchObject({ path: "/p", cliTool: "codex" });

    fireEvent.click(screen.getByText("recentLaunchTerminalOnly"));
    expect(useDialogStore.getState().pendingLaunch).toMatchObject({ path: "/p", cliTool: "none" });
  });
});
