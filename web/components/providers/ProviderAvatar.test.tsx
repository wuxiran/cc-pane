import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProviderType } from "@/types/provider";
import ProviderAvatar from "./ProviderAvatar";

function avatar(props: { name?: string; providerType: ProviderType; accentColor?: string }) {
  const { container } = render(<ProviderAvatar name={props.name ?? "X"} {...props} />);
  return container.firstElementChild as HTMLElement;
}

describe("ProviderAvatar", () => {
  it.each([
    ["anthropic", "A"],
    ["", "?"],
  ])("renders the uppercased first letter of %j", (name, letter) => {
    expect(avatar({ name, providerType: "anthropic" }).textContent).toBe(letter);
  });

  it("uses the type color token unless an explicit accentColor is given", () => {
    // 身份色改走 token，断言的是引用而非具体色值（亮暗两套定义在 index.css）
    expect(avatar({ providerType: "anthropic" }).style.background).toBe("var(--app-identity-provider-anthropic)");
    expect(avatar({ providerType: "anthropic", accentColor: "#123456" }).style.background).toBe("rgb(18, 52, 86)");
  });

  // bedrock/kimi 的品牌橙对白字只有 2.14/2.80，低于 3:1，换深墨前景；
  // 用户自填色无法判明度，不做深墨切换
  it.each<[ProviderType, string | undefined, string]>([
    ["bedrock", undefined, "var(--app-identity-provider-ink)"],
    ["kimi", undefined, "var(--app-identity-provider-ink)"],
    ["anthropic", undefined, "rgb(255, 255, 255)"],
    ["kimi", "#123456", "rgb(255, 255, 255)"],
  ])("foreground contrast: %s accent=%s → %s", (providerType, accentColor, color) => {
    expect(avatar({ providerType, accentColor }).style.color).toBe(color);
  });
});
