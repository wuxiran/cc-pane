import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DEFAULT_PRIVACY_SETTINGS } from "@/types/settings";
import PrivacySection from "./PrivacySection";

describe("PrivacySection", () => {
  it("隐私开关默认全部关闭（Dev 构建也一样）", () => {
    expect(Object.values(DEFAULT_PRIVACY_SETTINGS).every((value) => value === false)).toBe(true);
  });

  it("打开中转纯度检测", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PrivacySection value={DEFAULT_PRIVACY_SETTINGS} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: String(i18n.t("settings:privacy.channelPurity")) });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ channelPurity: true });
  });
});
