import { describe, expect, it } from "vitest";
import { maskSensitiveValue, normalizeMcpName, parseMcpPaste } from "./pasteMcpConfig";

describe("parseMcpPaste", () => {
  it("reads several servers from an mcpServers map", () => {
    const result = parseMcpPaste(`{"mcpServers":{
      "github":{"command":"npx","args":["-y","@x/github"],"env":{"GITHUB_TOKEN":"abc"}},
      "fs":{"command":"node","args":["fs.js"]}
    }}`);
    expect(result).toEqual({
      ok: true,
      servers: [
        { name: "github", command: "npx", args: ["-y", "@x/github"], env: { GITHUB_TOKEN: "abc" } },
        { name: "fs", command: "node", args: ["fs.js"], env: {} },
      ],
    });
  });

  it.each(["servers", "mcp", "context_servers"])("accepts the %s map", (key) => {
    const result = parseMcpPaste(JSON.stringify({ [key]: { a: { command: "x" } } }));
    expect(result.ok && result.servers.map((s) => s.name)).toEqual(["a"]);
  });

  it("tolerates trailing commas and a fragment with no outer braces", () => {
    const result = parseMcpPaste(`"docs": { "command": "uvx", "args": ["docs",], },`);
    expect(result).toEqual({ ok: true, servers: [{ name: "docs", command: "uvx", args: ["docs"], env: {} }] });
  });

  it("leaves the name empty for a bare entry", () => {
    const result = parseMcpPaste(`{"command":"uvx","args":["a"]}`);
    expect(result).toEqual({ ok: true, servers: [{ name: "", command: "uvx", args: ["a"], env: {} }] });
  });

  it("marks a remote entry with its url and headers", () => {
    const result = parseMcpPaste(`{"mcpServers":{"r":{"type":"http","url":"https://x/mcp","headers":{"Authorization":"Bearer t"}}}}`);
    expect(result).toEqual({
      ok: true,
      servers: [{ name: "r", command: "", args: [], env: {}, url: "https://x/mcp", headers: { Authorization: "Bearer t" } }],
    });
  });

  it("drops entries that are neither a command nor a url", () => {
    const result = parseMcpPaste(`{"mcpServers":{"bad":{"foo":1},"good":{"command":"x"}}}`);
    expect(result.ok && result.servers.map((s) => s.name)).toEqual(["good"]);
  });

  it("reports why nothing could be read", () => {
    expect(parseMcpPaste("   ")).toEqual({ ok: false, error: "empty" });
    expect(parseMcpPaste("not json at all")).toEqual({ ok: false, error: "invalidJson" });
    expect(parseMcpPaste(`{"mcpServers":{"bad":{"foo":1}}}`)).toEqual({ ok: false, error: "noServers" });
  });
});

describe("normalizeMcpName", () => {
  it("keeps only characters every CLI accepts", () => {
    expect(normalizeMcpName(" my server/v2 ")).toBe("my-server-v2");
    expect(normalizeMcpName("--a--")).toBe("a");
  });
});

describe("maskSensitiveValue", () => {
  it("masks values whose name looks like a credential", () => {
    expect(maskSensitiveValue("GITHUB_TOKEN", "abc")).not.toContain("abc");
    expect(maskSensitiveValue("Authorization", "Bearer x")).not.toContain("Bearer");
    expect(maskSensitiveValue("API_KEY", "abc")).not.toContain("abc");
  });

  it("leaves other values readable", () => {
    expect(maskSensitiveValue("REGION", "us-east-1")).toBe("us-east-1");
  });
});
