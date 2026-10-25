import { expect, it } from "vitest";
import { externalBrowserUrl, safeBrowserFavicon } from "./browserTabPresentation";

it("only accepts bounded raster data or same-origin HTTP favicon URLs", () => {
  expect(safeBrowserFavicon("/favicon.png", "https://example.com/page")).toBe("https://example.com/favicon.png");
  expect(safeBrowserFavicon("data:image/png;base64,aGVsbG8=", undefined)).toBe("data:image/png;base64,aGVsbG8=");
  for (const icon of ["javascript:alert(1)", "file:///etc/passwd", "data:image/svg+xml;base64,aGVsbG8=", "https://tracker.test/icon.png", "https://u:p@example.com/icon.png", `data:image/png;base64,${"a".repeat(128 * 1024)}`]) {
    expect(safeBrowserFavicon(icon, "https://example.com")).toBeUndefined();
  }
});

it("does not dispatch privileged, credential-bearing or blank URLs externally", () => {
  for (const url of ["file:///tmp/file", "javascript:alert(1)", "about:blank", "https://u:p@example.com", ""]) expect(externalBrowserUrl(url)).toBeUndefined();
  expect(externalBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000/");
});
