import { describe, it, expect } from "vitest";
import { parseEnvLines, formatEnvLines } from "./env";

describe("parseEnvLines", () => {
  it("多行 KEY=VALUE 解析为键值对", () => {
    const text = "HOST=localhost\nPORT=3000\nDEBUG=true";
    expect(parseEnvLines(text)).toEqual({
      HOST: "localhost",
      PORT: "3000",
      DEBUG: "true",
    });
  });

  it("空字符串返回空对象", () => {
    expect(parseEnvLines("")).toEqual({});
  });

  it("仅空白字符返回空对象", () => {
    expect(parseEnvLines("   \n  \n  ")).toEqual({});
  });

  it("无等号的行被忽略", () => {
    const text = "VALID=value\ninvalid_line\nANOTHER=ok";
    expect(parseEnvLines(text)).toEqual({
      VALID: "value",
      ANOTHER: "ok",
    });
  });

  it("值中含等号 - 只在第一个等号处分割", () => {
    const text = "KEY=a=b=c";
    expect(parseEnvLines(text)).toEqual({ KEY: "a=b=c" });
  });

  it("键值两端空格被 trim", () => {
    const text = "  KEY  =  value  ";
    expect(parseEnvLines(text)).toEqual({ KEY: "value" });
  });

  it("混合场景：空行、无等号行、正常行", () => {
    const text = "\nFOO=bar\n\nno-equals\nBAZ=qux\n";
    expect(parseEnvLines(text)).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("等号开头的行被忽略（idx === 0，不大于 0）", () => {
    const text = "=value\nKEY=ok";
    expect(parseEnvLines(text)).toEqual({ KEY: "ok" });
  });

  it("单行解析", () => {
    expect(parseEnvLines("SINGLE=val")).toEqual({ SINGLE: "val" });
  });
});

describe("formatEnvLines", () => {
  it("键值对格式化为多行文本", () => {
    const env = { A: "1", B: "2" };
    const result = formatEnvLines(env);
    // 对象属性顺序在现代 JS 引擎中按插入顺序
    expect(result).toBe("A=1\nB=2");
  });

  it("空对象返回空字符串", () => {
    expect(formatEnvLines({})).toBe("");
  });

  it("单个键值对", () => {
    expect(formatEnvLines({ KEY: "value" })).toBe("KEY=value");
  });

  it("值中包含等号", () => {
    expect(formatEnvLines({ KEY: "a=b" })).toBe("KEY=a=b");
  });

  it("值为空字符串", () => {
    expect(formatEnvLines({ EMPTY: "" })).toBe("EMPTY=");
  });
});
