import { describe, expect, it } from "vitest";
import { browserSecurityKind, normalizeBrowserUrl } from "./browserUrl";

describe("normalizeBrowserUrl", () => {
  it("uses http for localhost and loopback addresses", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("127.0.0.1:8080/path")).toBe("http://127.0.0.1:8080/path");
  });

  it("uses https for hostnames without a scheme", () => {
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs");
  });

  it("rejects unsupported schemes", () => {
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow("http");
    expect(() => normalizeBrowserUrl("file:///tmp/test.html")).toThrow("http");
  });
});

describe("browserSecurityKind", () => {
  it("distinguishes secure, local and insecure pages", () => {
    expect(browserSecurityKind("https://example.com")).toBe("secure");
    expect(browserSecurityKind("http://localhost:3000")).toBe("local");
    expect(browserSecurityKind("http://192.168.1.5")).toBe("local");
    expect(browserSecurityKind("http://example.com")).toBe("insecure");
  });
});
