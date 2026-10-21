import { describe, expect, it } from "vitest";
import { navigationBreadcrumbs, normalizeNavigationPath, parentNavigationPath } from "./path";

describe("filesystem navigation roots", () => {
  it.each(["C:/", "C:\\", "C:////", "\\\\?\\C:\\", "//?/C:/"])("preserves drive root %s", (path) => {
    expect(normalizeNavigationPath(path)).toBe("C:/");
    expect(parentNavigationPath(path)).toBe("C:/");
    expect(navigationBreadcrumbs(path)).toEqual([{ label: "C:", path: "C:/" }]);
  });

  it.each(["//server/share/", "\\\\server\\share\\", "\\\\?\\UNC\\server\\share\\"])("keeps UNC share root %s atomic", (path) => {
    expect(normalizeNavigationPath(path)).toBe("//server/share");
    expect(parentNavigationPath(path)).toBe("//server/share");
    expect(navigationBreadcrumbs(path)).toEqual([{ label: "//server/share", path: "//server/share" }]);
  });

  it("constructs drive and UNC descendants without duplicate or missing separators", () => {
    expect(navigationBreadcrumbs("D:\\work\\repo")).toEqual([
      { label: "D:", path: "D:/" }, { label: "work", path: "D:/work" }, { label: "repo", path: "D:/work/repo" },
    ]);
    expect(navigationBreadcrumbs("//server/share/work/repo")).toEqual([
      { label: "//server/share", path: "//server/share" },
      { label: "work", path: "//server/share/work" }, { label: "repo", path: "//server/share/work/repo" },
    ]);
    expect(parentNavigationPath("//server/share/work")).toBe("//server/share");
  });

  it("treats repeated separators after a drive as a filesystem path, while keeping SSH schemes", () => {
    expect(normalizeNavigationPath("C://foo")).toBe("C:/foo");
    expect(normalizeNavigationPath("D:////work//repo/")).toBe("D:/work/repo");
    expect(parentNavigationPath("C://foo")).toBe("C:/");
    expect(navigationBreadcrumbs("C://foo")).toEqual([
      { label: "C:", path: "C:/" }, { label: "foo", path: "C:/foo" },
    ]);
    expect(normalizeNavigationPath("ssh://User@Host:22//foo/")).toBe("ssh://User@Host:22/foo");
    expect(parentNavigationPath("ssh://User@Host:22//foo/")).toBe("ssh://User@Host:22/");
  });

  it("preserves WSL UNC roots instead of turning them into POSIX or host drive paths", () => {
    expect(parentNavigationPath("\\\\wsl.localhost\\Ubuntu\\home")).toBe("//wsl.localhost/Ubuntu");
    expect(normalizeNavigationPath("\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src")).toBe("//wsl.localhost/Ubuntu/mnt/c/src");
  });

  it("preserves POSIX filename backslashes and dot segments", () => {
    expect(normalizeNavigationPath("/srv/a\\b/../repo/")).toBe("/srv/a\\b/../repo");
    expect(parentNavigationPath("/srv/a\\b/file")).toBe("/srv/a\\b");
    expect(parentNavigationPath("/")).toBe("/");
    expect(navigationBreadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("preserves SSH authority and remote POSIX backslashes", () => {
    expect(normalizeNavigationPath("ssh://User@Host:22/srv/a\\b/")).toBe("ssh://User@Host:22/srv/a\\b");
    expect(parentNavigationPath("ssh://User@Host:22/srv")).toBe("ssh://User@Host:22/");
    expect(parentNavigationPath("//srv/share/a\\b", "posix")).toBe("//srv/share");
    expect(navigationBreadcrumbs("/srv/a\\b/file", "posix")[1]).toEqual({ label: "a\\b", path: "/srv/a\\b" });
  });

  it("does not turn explicitly drive-relative or ordinary relative paths into absolute paths", () => {
    expect(normalizeNavigationPath("C:work\\repo")).toBe("C:work/repo");
    expect(parentNavigationPath("C:work")).toBe("C:");
    expect(parentNavigationPath("relative")).toBe("relative");
    expect(navigationBreadcrumbs("relative/child")[1].path).toBe("relative/child");
    expect(normalizeNavigationPath("")).toBe("");
  });
});
