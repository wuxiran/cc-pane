import { describe, expect, it } from "vitest";
import { maskEmail } from "./maskEmail";

describe("maskEmail", () => {
  it("keeps the first two chars of the local part and the domain", () => {
    expect(maskEmail("wuxiran@example.com")).toBe("wu***@example.com");
  });

  it("handles short local parts", () => {
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("ab@b.co")).toBe("ab***@b.co");
  });

  it("uses the last @ as the separator", () => {
    expect(maskEmail("we@ird@example.com")).toBe("we***@example.com");
  });

  it("returns non-email values unchanged", () => {
    expect(maskEmail("work account")).toBe("work account");
    expect(maskEmail("@example.com")).toBe("@example.com");
    expect(maskEmail("name@")).toBe("name@");
    expect(maskEmail("")).toBe("");
  });

  it("does not split multi-byte characters", () => {
    expect(maskEmail("张三丰@example.com")).toBe("张三***@example.com");
  });
});
