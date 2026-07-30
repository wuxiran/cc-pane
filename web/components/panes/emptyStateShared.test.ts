import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE_COMPACT_MAX_WIDTH,
  EMPTY_STATE_MINI_MAX_WIDTH,
  resolveEmptyStateDensity,
} from "./emptyStateShared";

describe("resolveEmptyStateDensity", () => {
  it("按窗格宽度分三档，阈值取下界闭合", () => {
    expect(resolveEmptyStateDensity(1200)).toBe("full");
    expect(resolveEmptyStateDensity(EMPTY_STATE_COMPACT_MAX_WIDTH)).toBe("full");
    expect(resolveEmptyStateDensity(EMPTY_STATE_COMPACT_MAX_WIDTH - 1)).toBe("compact");
    expect(resolveEmptyStateDensity(EMPTY_STATE_MINI_MAX_WIDTH)).toBe("compact");
    expect(resolveEmptyStateDensity(EMPTY_STATE_MINI_MAX_WIDTH - 1)).toBe("mini");
  });

  it("对半分屏后由 full 落到 compact —— 这是本次要修的场景", () => {
    const paneWidth = 900;
    expect(resolveEmptyStateDensity(paneWidth)).toBe("full");
    expect(resolveEmptyStateDensity(paneWidth / 2)).toBe("compact");
    expect(resolveEmptyStateDensity(paneWidth / 4)).toBe("mini");
  });
});
