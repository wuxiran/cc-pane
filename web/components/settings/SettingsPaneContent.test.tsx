/**
 * 回归测试：分片取回失败的影响面必须止步于当前设置分区。
 *
 * 事故形态（见 cc-panes.log 2026-08-04/05）：dev server 抖动导致
 * `GeneralSection.tsx` 取不回来，throw 一路冒泡到 App.tsx 顶层 ErrorBoundary，
 * 整个窗口被换成错误页——用户看到的是"应用挂了"，实际只是一个设置分区没加载出来。
 */
import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(() => Promise.resolve()) }));

// 让 general 分区的动态 import 稳定失败，模拟 dev server 抖动。
// hoisted 到 SettingsPaneContent 求值之前，因此它的 lazy 工厂拿到的就是这个 reject。
vi.mock("./GeneralSection", () => ({
  get default(): never {
    throw new TypeError(
      "Failed to fetch dynamically imported module: http://localhost:14200/web/components/settings/GeneralSection.tsx",
    );
  },
}));

import SettingsPaneContent from "./SettingsPaneContent";
import type { SettingsDraft } from "./settingsDraft";

// general 分区只读这四个字段；引真实 store 会拖进 stores/index → selfChatService 的
// 循环依赖，在测试环境下 subscribe 尚未定义就被调用。
const draft = {
  general: {},
  localHistory: { enabled: true },
  update: { notifyEnabled: true },
  tips: { enabled: true },
} as unknown as SettingsDraft;

function OuterBoundaryProbe({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

describe("SettingsPaneContent 分片失败隔离", () => {
  test("分区加载失败时只换掉该分区，不冒泡到外层", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <OuterBoundaryProbe>
        <div data-testid="app-chrome">
          <SettingsPaneContent paneId="general" draft={draft} updateDraft={vi.fn()} />
        </div>
      </OuterBoundaryProbe>,
    );

    // 分区内部降级为错误提示……
    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch dynamically imported module/)).toBeInTheDocument();
    });
    // ……而承载它的应用外壳仍然活着（这正是事故里丢掉的东西）。
    expect(screen.getByTestId("app-chrome")).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
