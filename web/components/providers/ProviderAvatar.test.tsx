import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProviderAvatar from "./ProviderAvatar";

describe("ProviderAvatar", () => {
  it("renders the uppercased first letter of the name", () => {
    const { container } = render(
      <ProviderAvatar name="anthropic" providerType="anthropic" />
    );
    expect(container.textContent).toBe("A");
  });

  it("falls back to ? when name is empty", () => {
    const { container } = render(
      <ProviderAvatar name="" providerType="anthropic" />
    );
    expect(container.textContent).toBe("?");
  });

  it("uses the type color when no accentColor is given", () => {
    const { container } = render(
      <ProviderAvatar name="Claude" providerType="anthropic" />
    );
    const div = container.firstElementChild as HTMLElement;
    // 身份色改走 token，断言的是引用而非具体色值（亮暗两套定义在 index.css）
    expect(div.style.background).toBe("var(--app-identity-provider-anthropic)");
  });

  it("prefers explicit accentColor over the type color", () => {
    const { container } = render(
      <ProviderAvatar name="X" providerType="anthropic" accentColor="#123456" />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.background).toBe("rgb(18, 52, 86)");
  });

  it("uses dark ink on the light identity swatches", () => {
    // bedrock/kimi 的品牌橙对白字只有 2.14/2.80，低于 3:1
    for (const type of ["bedrock", "kimi"] as const) {
      const { container } = render(<ProviderAvatar name="X" providerType={type} />);
      const div = container.firstElementChild as HTMLElement;
      expect(div.style.color).toBe("var(--app-identity-provider-ink)");
    }
  });

  it("keeps white text on the dark identity swatches", () => {
    const { container } = render(<ProviderAvatar name="X" providerType="anthropic" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.color).toBe("rgb(255, 255, 255)");
  });

  it("keeps white text when the user supplies an accentColor", () => {
    // 用户自填色无法在此判明度，不做深墨切换
    const { container } = render(
      <ProviderAvatar name="X" providerType="kimi" accentColor="#123456" />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.color).toBe("rgb(255, 255, 255)");
  });

  it("scales avatar and font size from the size prop", () => {
    const { container } = render(
      <ProviderAvatar name="X" providerType="kimi" size={100} />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.width).toBe("100px");
    expect(div.style.height).toBe("100px");
    expect(div.style.fontSize).toBe("42px"); // size * 0.42
  });
});
