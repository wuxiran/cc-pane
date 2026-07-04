import { describe, it, expect, afterEach, vi } from "vitest";
import { webAuthService, type WebAuthStatus } from "./webAuthService";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("webAuthService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("status", () => {
    it("应该请求 /api/auth/status 并返回状态", async () => {
      const status: WebAuthStatus = {
        authRequired: true,
        authenticated: false,
        username: "admin",
        passwordConfigured: true,
        allowLan: false,
        lockOnIdleMinutes: 15,
        readOnly: false,
      };
      const fetchMock = mockFetch(jsonResponse(status));

      const result = await webAuthService.status();

      expect(fetchMock).toHaveBeenCalledWith("/api/auth/status", undefined);
      expect(result).toEqual(status);
    });
  });

  describe("login", () => {
    it("应该 POST 登录请求到 /api/auth/login", async () => {
      const fetchMock = mockFetch(jsonResponse({ authenticated: true }));

      await webAuthService.login({ username: "admin", password: "secret" });

      expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
    });

    it("应该在登录失败时抛出后端错误消息", async () => {
      mockFetch(new Response("invalid credentials", { status: 401 }));

      await expect(
        webAuthService.login({ username: "admin", password: "wrong" }),
      ).rejects.toThrow("invalid credentials");
    });
  });

  describe("lock", () => {
    it("应该 POST 到 /api/auth/logout", async () => {
      const fetchMock = mockFetch(jsonResponse({ locked: true }));

      await webAuthService.lock();

      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });
  });
});
