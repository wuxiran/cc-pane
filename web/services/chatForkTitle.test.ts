import { describe, expect, it } from "vitest";
import { nextForkTitle } from "./chatForkLaunch";

describe("nextForkTitle", () => {
  it("numbers forks from (1) and fills the lowest gap", () => {
    expect(nextForkTitle("cc-pane (Claude)", ["cc-pane (Claude)"])).toBe("cc-pane (Claude) (1)");
    expect(nextForkTitle("cc-pane (Claude)", ["cc-pane (Claude) (1)", "cc-pane (Claude) (3)"])).toBe("cc-pane (Claude) (2)");
  });

  it("forking a fork does not stack suffixes", () => {
    expect(nextForkTitle("cc-pane (Claude) (1)", ["cc-pane (Claude) (1)"])).toBe("cc-pane (Claude) (2)");
  });
});
