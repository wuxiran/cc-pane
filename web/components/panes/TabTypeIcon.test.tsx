import { fireEvent, render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Tab } from "@/types";
import TabTypeIcon from "./TabTypeIcon";

it("uses a safe favicon, then falls back to the browser icon if it cannot load", () => {
  const tab: Tab = { id: "browser", title: "Page", contentType: "browser", projectId: "", projectPath: "", sessionId: null,
    browserUrl: "https://example.com", browserFaviconUrl: "https://example.com/favicon.png" };
  const { container, rerender } = render(<TabTypeIcon tab={tab} statusSize={6} iconSize={14} getStatus={() => null} />);
  const image = container.querySelector("img")!;
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
  rerender(<TabTypeIcon tab={{ ...tab, browserFaviconUrl: "javascript:alert(1)" }} statusSize={6} iconSize={14} getStatus={() => null} />);
  expect(container.querySelector("img")).toBeNull();
});
