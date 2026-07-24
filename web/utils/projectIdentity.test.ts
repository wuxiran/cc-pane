import { describe, expect, it } from "vitest";
import { projectIdentityKey, projectPathsEquivalent } from "./projectIdentity";

describe("project identity", () => {
  it("统一盘符大小写、分隔符、verbatim 前缀和尾分隔符", () => {
    expect(projectPathsEquivalent(
      "\\\\?\\d:\\Repos\\Alpha\\",
      "D:/repos/alpha",
    )).toBe(true);
    expect(projectIdentityKey("/mnt/d/Repos/Alpha/")).toBe("d:\\repos\\alpha");
  });

  it("统一 WSL mount UNC 与 Windows 盘符路径", () => {
    expect(projectPathsEquivalent(
      "\\\\wsl$\\Ubuntu\\mnt\\d\\Repos\\Alpha",
      "D:/repos/alpha",
    )).toBe(true);
  });

  it("统一 WSL Linux UNC server 别名但保留 distro 与路径大小写", () => {
    expect(projectPathsEquivalent(
      "\\\\wsl$\\Ubuntu\\home\\User\\Repo\\",
      "\\\\wsl.localhost\\Ubuntu\\home\\User\\Repo",
    )).toBe(true);
    expect(projectPathsEquivalent(
      "\\\\wsl.localhost\\Ubuntu\\home\\User\\Repo",
      "\\\\wsl.localhost\\ubuntu\\home\\User\\Repo",
    )).toBe(false);
    expect(projectPathsEquivalent(
      "\\\\wsl.localhost\\Ubuntu\\home\\User\\Repo",
      "\\\\wsl.localhost\\Ubuntu\\home\\user\\Repo",
    )).toBe(false);
  });

  it("普通 UNC 仅统一分隔符并保持大小写敏感", () => {
    expect(projectPathsEquivalent(
      "\\\\server\\share\\Folder\\",
      "//server/share/Folder/",
    )).toBe(true);
    expect(projectPathsEquivalent(
      "\\\\server\\share\\Folder",
      "\\\\server\\share\\folder",
    )).toBe(false);
  });

  it("POSIX 与 SSH 项目身份保持大小写敏感", () => {
    expect(projectPathsEquivalent("/home/User/Repo", "/home/user/Repo")).toBe(false);
    expect(projectPathsEquivalent(
      "ssh://dev@example.com/home/Repo/",
      "ssh://dev@example.com/home/repo/",
    )).toBe(false);
  });
});
