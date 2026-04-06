import { describe, it, expect } from "vitest";
import { getFileName, getDirName, getProjectName, getWslUncRemotePath, isWslUncPath, toWslPath } from "./path";

describe("getFileName", () => {
  it("正斜杠路径提取文件名", () => {
    expect(getFileName("/home/user/file.txt")).toBe("file.txt");
  });

  it("反斜杠路径提取文件名", () => {
    expect(getFileName("C:\\Users\\file.txt")).toBe("file.txt");
  });

  it("仅文件名直接返回", () => {
    expect(getFileName("file.txt")).toBe("file.txt");
  });

  it("空字符串返回空字符串", () => {
    expect(getFileName("")).toBe("");
  });

  it("多级目录路径", () => {
    expect(getFileName("/a/b/c/d/test.rs")).toBe("test.rs");
  });

  it("Windows 多级目录路径", () => {
    expect(getFileName("D:\\workspace\\project\\src\\main.rs")).toBe("main.rs");
  });

  it("尾部斜杠 - pop 为空字符串时返回原始路径", () => {
    // 实现中 "" || path 返回原始 path
    expect(getFileName("/home/user/")).toBe("/home/user/");
  });
});

describe("getDirName", () => {
  it("正斜杠路径提取目录", () => {
    expect(getDirName("/home/user/file.txt")).toBe("/home/user/");
  });

  it("反斜杠路径提取目录（统一为正斜杠）", () => {
    expect(getDirName("C:\\Users\\file.txt")).toBe("C:/Users/");
  });

  it("仅文件名返回空字符串", () => {
    // "file.txt" -> split("/") = ["file.txt"], pop 后 parts = [], 返回 ""
    expect(getDirName("file.txt")).toBe("");
  });

  it("根路径", () => {
    // "/" -> split("/") = ["", ""], pop 后 parts = [""], 返回 "/"
    expect(getDirName("/")).toBe("/");
  });

  it("多级目录", () => {
    expect(getDirName("/a/b/c/file.txt")).toBe("/a/b/c/");
  });

  it("Windows 多级目录", () => {
    expect(getDirName("D:\\workspace\\project\\main.rs")).toBe(
      "D:/workspace/project/"
    );
  });
});

describe("getProjectName", () => {
  it("正斜杠路径提取最后一段", () => {
    expect(getProjectName("/home/user/my-project")).toBe("my-project");
  });

  it("反斜杠路径提取最后一段", () => {
    expect(getProjectName("C:\\Users\\my-project")).toBe("my-project");
  });

  it("仅名称直接返回", () => {
    expect(getProjectName("my-project")).toBe("my-project");
  });

  it("多级目录取最后一段", () => {
    expect(getProjectName("/a/b/c/awesome-app")).toBe("awesome-app");
  });

  it("Windows 深层路径", () => {
    expect(getProjectName("D:\\workspace\\rust\\cc-panes")).toBe("cc-panes");
  });

  it("空字符串返回空字符串", () => {
    // "".split("/") = [""], pop = "", "" || "" = ""
    expect(getProjectName("")).toBe("");
  });
});

describe("toWslPath", () => {
  it("Windows 驱动器路径转为 WSL 路径", () => {
    expect(toWslPath("D:\\workspace\\cc-book")).toBe("/mnt/d/workspace/cc-book");
  });

  it("WSL localhost UNC 路径转为 Linux 路径", () => {
    expect(toWslPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo")).toBe("/home/dev/repo");
  });

  it("WSL $ UNC 路径转为 Linux 路径", () => {
    expect(toWslPath("\\\\wsl$\\Ubuntu\\home\\dev\\repo")).toBe("/home/dev/repo");
  });

  it("盘符根目录转为 WSL 路径", () => {
    expect(toWslPath("C:\\")).toBe("/mnt/c");
  });

  it("非 Windows 本地路径返回 null", () => {
    expect(toWslPath("/home/user/project")).toBeNull();
  });

  it("空路径返回 null", () => {
    expect(toWslPath("")).toBeNull();
  });
});

describe("getWslUncRemotePath", () => {
  it("提取 WSL UNC 远端路径", () => {
    expect(getWslUncRemotePath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo")).toBe("/home/dev/repo");
  });

  it("WSL UNC 根目录映射为 /", () => {
    expect(getWslUncRemotePath("\\\\wsl.localhost\\Ubuntu\\")).toBe("/");
  });

  it("非 WSL UNC 路径返回 null", () => {
    expect(getWslUncRemotePath("D:\\workspace\\repo")).toBeNull();
  });
});

describe("isWslUncPath", () => {
  it("识别 wsl.localhost UNC 路径", () => {
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo")).toBe(true);
  });

  it("识别 wsl$ UNC 路径", () => {
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\dev\\repo")).toBe(true);
  });

  it("忽略 Windows 本地路径和普通 Linux 路径", () => {
    expect(isWslUncPath("D:\\workspace\\repo")).toBe(false);
    expect(isWslUncPath("/home/dev/repo")).toBe(false);
  });
});
