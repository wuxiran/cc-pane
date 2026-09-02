import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AcpConfigOption } from "@/types/agentChat";
import ConfigOptionSelectors, { selectableConfigOptions } from "./ConfigOptionSelectors";

const OPTIONS: AcpConfigOption[] = [
  {
    configId: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "m1",
    options: [{ value: "m1", name: "Model 1" }, { value: "m2", name: "Model 2" }],
  },
  {
    configId: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
  },
  { configId: "flag", name: "Some toggle", type: "boolean", currentValue: true },
  { configId: "empty", name: "No choices", type: "select", currentValue: "x", options: [] },
];

describe("selectableConfigOptions", () => {
  it("只保留有选项的 select，并按类别去重 legacy 选择器", () => {
    expect(selectableConfigOptions(OPTIONS, new Set()).map((o) => o.configId)).toEqual([
      "model",
      "reasoning_effort",
    ]);
    expect(selectableConfigOptions(OPTIONS, new Set(["model"])).map((o) => o.configId)).toEqual([
      "reasoning_effort",
    ]);
    expect(selectableConfigOptions(undefined, new Set())).toEqual([]);
  });
});

describe("ConfigOptionSelectors", () => {
  it("渲染思维深度选择器并在选择时回传 option + value", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ConfigOptionSelectors options={OPTIONS} hiddenCategories={new Set(["model"])} onSelect={onSelect} />,
    );
    // 当前值 medium 显示在触发按钮上；Model 类别已被 legacy 占用，不再出现
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.queryByText("Model 1")).not.toBeInTheDocument();

    await user.click(screen.getByText("medium"));
    await user.click(await screen.findByText("high"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "reasoning_effort", category: "thought_level" }),
      "high",
    );
  });
});
