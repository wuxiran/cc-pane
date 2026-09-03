import type { Provider } from "@/types/provider";

/**
 * One-shot LLM text completion for the media prompt copilot.
 *
 * There is intentionally no session or tool protocol here: the copilot needs
 * "prompt in, text out" against a provider the user already saved. Providers
 * used by the CLI launchers speak either the Anthropic Messages API
 * (anthropic itself and Claude-Code proxies) or an OpenAI-compatible
 * chat/completions endpoint; both are called directly from the webview (the
 * Tauri CSP allows https connects).
 */
export interface PromptCompletionRequest {
  provider: Provider;
  modelId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

/** Provider types whose baseUrl speaks the Anthropic Messages protocol. */
const ANTHROPIC_PROTOCOL_TYPES = new Set(["anthropic", "proxy", "kimi"]);

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function endpointFor(base: string, suffix: string): string {
  return /\/v\d+$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

async function completeAnthropic(request: PromptCompletionRequest): Promise<string> {
  const base = normalizeBase(request.provider.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE);
  const response = await fetch(endpointFor(base, "/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": request.provider.apiKey ?? "",
      "authorization": `Bearer ${request.provider.apiKey ?? ""}`,
      "anthropic-version": "2023-06-01",
      // Anthropic rejects browser-origin requests unless this opt-in is set.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: request.modelId,
      max_tokens: request.maxTokens ?? 2048,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) throw new Error("Empty completion response");
  return text.trim();
}

async function completeOpenAi(request: PromptCompletionRequest): Promise<string> {
  const rawBase = request.provider.baseUrl?.trim();
  if (!rawBase) throw new Error("Provider has no base URL");
  const response = await fetch(endpointFor(normalizeBase(rawBase), "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${request.provider.apiKey ?? ""}`,
    },
    body: JSON.stringify({
      model: request.modelId,
      max_tokens: request.maxTokens ?? 2048,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty completion response");
  return text.trim();
}

/** True when the provider stores enough credentials for a direct completion. */
export function supportsPromptCompletion(provider: Provider): boolean {
  // Media providers speak image/video APIs, not chat completions.
  if (provider.providerType === "media") return false;
  if (!provider.apiKey?.trim()) return false;
  if (ANTHROPIC_PROTOCOL_TYPES.has(provider.providerType)) return true;
  return Boolean(provider.baseUrl?.trim());
}

export async function completePrompt(request: PromptCompletionRequest): Promise<string> {
  return ANTHROPIC_PROTOCOL_TYPES.has(request.provider.providerType)
    ? completeAnthropic(request)
    : completeOpenAi(request);
}
