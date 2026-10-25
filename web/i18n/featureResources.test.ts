import { describe, expect, it } from "vitest";
import i18n from "./index";

describe("feature translations loaded with lazy components", () => {
  it("keeps the new-tab title eager and loads detailed page copy with the page", async () => {
    expect(i18n.getFixedT("en", "panes")("newTabPage.title")).toBe("New tab");
    await import("./newTabPageResources");
    expect(i18n.getFixedT("en", "panes")("newTabPage.address")).toBe("Enter a website address");
    expect(i18n.getFixedT("zh-CN", "panes")("newTabPage.title")).toBe("新标签页");
    expect(i18n.getFixedT("zh-CN", "panes")("newTabPage.pageHint")).not.toContain("newTabPage.");
  });

  it("loads the binding dialog copy separately while keeping tab tooltip labels eager", async () => {
    expect(i18n.getFixedT("en", "panes")("sessionBindUnboundTooltip")).toContain("Click to bind");
    await import("./sessionBindResources");
    expect(i18n.getFixedT("en", "panes")("sessionBindAction")).toBe("Bind");
    expect(i18n.getFixedT("zh-CN", "panes")("sessionBindTitle")).toBe("会话绑定");
  });
  it("keeps the fork-review entry translated and loads all detailed strings in both languages", async () => {
    expect(i18n.getFixedT("zh-CN", "panes")("forkReviewTitle")).toBe("比较分叉结果");
    await import("./forkReviewResources");
    const zh = i18n.getFixedT("zh-CN", "panes");
    const en = i18n.getFixedT("en", "panes");
    expect(zh("forkReviewPartialConflict")).toContain("单独的代码片段");
    expect(en("forkReviewPartialConflict")).toContain("individual hunks");
    expect(zh("forkReviewPreviewTruncated", { count: 2000 })).toContain("2000 行");
    expect(en("forkReviewPreviewTruncated", { count: 2000 })).toContain("2000 lines");
    expect(zh("forkReviewPreviousHunks")).toBe("上一页片段");
    expect(en("forkReviewPreviousHunks")).toBe("Previous hunks");
    expect(zh("forkReviewNextHunks")).toBe("下一页片段");
    expect(en("forkReviewNextHunks")).toBe("Next hunks");
    expect(zh("forkReviewHunkPage", { page: 2, count: 3 })).toBe("代码片段第 2 / 3 页");
    expect(en("forkReviewHunkPage", { page: 2, count: 3 })).toBe("Hunk page 2 of 3");
  });

  it("keeps the verification loading title translated and registers detailed evidence strings", async () => {
    expect(i18n.getFixedT("zh-CN", "orchestration")("verification.title")).toBe("验收证据");
    await import("./taskVerificationResources");
    expect(i18n.getFixedT("en", "orchestration")("verification.passed")).toBe("Passed · current code");
    expect(i18n.getFixedT("zh-CN", "orchestration")("verification.passed")).toBe("通过 · 当前代码");
  });
});
