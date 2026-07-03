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
    expect(div.style.background).toBe("rgb(232, 89, 12)"); // #E8590C
  });

  it("prefers explicit accentColor over the type color", () => {
    const { container } = render(
      <ProviderAvatar name="X" providerType="anthropic" accentColor="#123456" />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.background).toBe("rgb(18, 52, 86)");
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
