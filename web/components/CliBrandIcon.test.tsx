import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CLI_TOOL_TABS } from "@/types/provider";
import CliBrandIcon, { CLI_BRAND_ICON_TOOLS } from "./CliBrandIcon";

describe("CliBrandIcon", () => {
  it("covers every Provider CLI tab with a dedicated mark", () => {
    expect(CLI_BRAND_ICON_TOOLS).toEqual(CLI_TOOL_TABS.map((tab) => tab.id));
    for (const tab of CLI_TOOL_TABS) {
      const { container } = render(<CliBrandIcon cliTool={tab.id} />);
      const svg = container.querySelector(`[data-cli-brand="${tab.id}"]`);
      expect(svg).not.toBeNull();
      expect(svg?.querySelector("path")).not.toBeNull();
    }
  });
});
