import { describe, expect, it } from "vitest";
import fixture from "../../cc-panes-paths/tests/fixtures/wsl_path_cases.json";
import { projectIdentityKey } from "./projectIdentity";
import { mntDriveLetter, parseWslUnc, toWslPosix, wslCompareKey } from "./wslPath";

interface FixtureCase {
  name: string;
  input: string;
  identityKey: string;
  wslCompareKey: string;
  toWslPosix: string | null;
  parseWslUnc: { distro: string; posix: string } | null;
}

const cases = fixture.cases as FixtureCase[];

// 与 cc-panes-paths/tests/fixture_cases.rs 跑同一份用例表，保证前后端语义一致。
describe("wslPath 与 cc-panes-paths 对拍", () => {
  it("用例表不为空", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases)("$name", (testCase) => {
    it("wslCompareKey", () => {
      expect(wslCompareKey(testCase.input)).toBe(testCase.wslCompareKey);
    });

    it("toWslPosix", () => {
      expect(toWslPosix(testCase.input, fixture.mountRoot)).toBe(testCase.toWslPosix);
    });

    it("parseWslUnc", () => {
      expect(parseWslUnc(testCase.input)).toEqual(testCase.parseWslUnc);
    });

    it("projectIdentityKey 与 identity_key 一致", () => {
      expect(projectIdentityKey(testCase.input)).toBe(testCase.identityKey);
    });
  });
});

describe("mntDriveLetter", () => {
  it("只认路径开头的挂载盘", () => {
    expect(mntDriveLetter("/mnt/d")).toBe("d");
    expect(mntDriveLetter("/mnt/D/x")).toBe("d");
    expect(mntDriveLetter("/mnt/data/x")).toBeNull();
    expect(mntDriveLetter("/home/u/mnt/a/foo")).toBeNull();
  });
});

describe("toWslPosix", () => {
  it("支持自定义挂载根", () => {
    expect(toWslPosix("D:\\Repo", "/win/")).toBe("/win/d/Repo");
  });

  it("空值返回 null", () => {
    expect(toWslPosix("")).toBeNull();
    expect(toWslPosix(null)).toBeNull();
  });
});
