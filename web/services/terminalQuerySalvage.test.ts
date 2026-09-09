import { describe, expect, it } from "vitest";
import { extractTerminalQueries } from "./terminalQuerySalvage";

describe("extractTerminalQueries", () => {
  it("keeps parser queries and drops ordinary output", () => {
    expect(extractTerminalQueries("text\x1b[6nmore\x1b[c\x1b[?25$p"))
      .toBe("\x1b[6n\x1b[c\x1b[?25$p");
  });

  it("recognizes CPR, DA, Kitty and OSC color queries", () => {
    expect(extractTerminalQueries("\x1b[?6n\x1b[>c\x1b[?u\x1b]10;?\x07"))
      .toBe("\x1b[?6n\x1b[>c\x1b[?u\x1b]10;?\x07");
  });

  it("does not pass state-changing sequences through the salvage path", () => {
    expect(extractTerminalQueries("\x1b[2J\x1b[?1049h\x1b]0;title\x07")).toBe("");
  });
});

