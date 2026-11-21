import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completePrompt, supportsPromptCompletion } from "./promptCopilotService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { Provider } from "@/types/provider";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p-1",
    name: "Relay",
    providerType: "anthropic",
    isDefault: false,
    accounts: [{ id: "default", name: "默认", kind: "api_key", secretStorage: "keychain" }],
    defaultAccountId: "default",
    ...overrides,
  };
}

describe("promptCopilotService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("按「默认账号有没有密钥」的标记判断是否可用（密钥本身读不到）", () => {
    expect(supportsPromptCompletion(makeProvider())).toBe(true);
    expect(
      supportsPromptCompletion(
        makeProvider({ accounts: [{ id: "default", name: "默认", kind: "api_key", secretStorage: "none" }] }),
      ),
    ).toBe(false);
    expect(
      supportsPromptCompletion(
        makeProvider({
          accounts: [{ id: "default", name: "默认", kind: "login", cliTool: "claude", configDir: "/accounts/a" }],
        }),
      ),
    ).toBe(false);
    // OpenAI 兼容类型还需要接口地址。
    expect(supportsPromptCompletion(makeProvider({ providerType: "open_ai" }))).toBe(false);
    expect(
      supportsPromptCompletion(makeProvider({ providerType: "open_ai", baseUrl: "https://relay.example/v1" })),
    ).toBe(true);
  });

  it("补全时向后端取这一次要用的密钥和地址，而不是从 Provider 列表里读", async () => {
    mockTauriInvoke({
      resolve_provider_api_credentials: { apiKey: "sk-from-keychain", baseUrl: "https://relay.example" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: " done " }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const reply = await completePrompt({
      provider: makeProvider(),
      modelId: "claude-x",
      system: "sys",
      prompt: "hello",
    });

    expect(reply).toBe("done");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-from-keychain");
  });
});
