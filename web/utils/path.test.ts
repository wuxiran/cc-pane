import { describe, it, expect } from "vitest";
import { getFileName, getDirName, getProjectName } from "./path";

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
