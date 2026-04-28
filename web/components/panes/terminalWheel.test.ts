import { describe, expect, it } from "vitest";
import { resolveTerminalWheelMode } from "./terminalWheel";

describe("terminalWheel", () => {
  it("lets the browser scroll normal-buffer history when scrollback exists", () => {
    expect(
      resolveTerminalWheelMode({
        bufferType: "normal",
        baseY: 20,
      })
    ).toBe("browser-history");
  });

  it("keeps alternate-buffer wheel events routed to the terminal app", () => {
    expect(
      resolveTerminalWheelMode({
        bufferType: "alternate",
        baseY: 0,
      })
    ).toBe("alternate-app");
  });

  it("uses xterm defaults when the normal buffer has no scrollback", () => {
    expect(
      resolveTerminalWheelMode({
        bufferType: "normal",
        baseY: 0,
      })
    ).toBe("xterm-default");
  });
});
