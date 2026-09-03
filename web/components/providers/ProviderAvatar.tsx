import type { ProviderType } from "@/types/provider";

/**
 * Provider 类型的**身份色**（各家品牌色），仅用于头像等标识性元素。
 * 属 identity 语义，不参与状态表达 —— 状态色一律用 `--app-accent` 等 token。
 * 值走 `--app-identity-provider-*`（亮暗两套见 index.css），暗色下 cursor/config_profile
 * 会换成对暗底成立的值；内联 style 直接吃 `var()`，无需在 JS 里解析。
 */
export const PROVIDER_TYPE_COLORS: Record<ProviderType, string> = {
  anthropic: "var(--app-identity-provider-anthropic)",
  bedrock: "var(--app-identity-provider-bedrock)",
  vertex: "var(--app-identity-provider-vertex)",
  proxy: "var(--app-identity-provider-proxy)",
  config_profile: "var(--app-identity-provider-config-profile)",
  open_ai: "var(--app-identity-provider-open-ai)",
  gemini: "var(--app-identity-provider-gemini)",
  kimi: "var(--app-identity-provider-kimi)",
  opencode: "var(--app-identity-provider-opencode)",
  cursor: "var(--app-identity-provider-cursor)",
  grok: "var(--app-identity-provider-grok)",
  // 媒体 Provider 没有独立品牌色，沿用 open-ai 的色板。
  media: "var(--app-identity-provider-open-ai)",
};

interface ProviderAvatarProps {
  name: string;
  providerType: ProviderType;
  accentColor?: string;
  size?: number;
}

/**
 * 白字压不住的浅色身份底：bedrock #FF9900 与 kimi #F97316 对白字只有 2.14:1 / 2.80:1，
 * 低于 docs/46 §9 的 3:1（大号粗体）。品牌色不动，改深墨前景（8.29:1 / 6.33:1）。
 * 亮暗同值 —— 底色是品牌色而非主题色，前景不随主题翻转。
 */
const INK_ON_LIGHT_IDENTITY = new Set<ProviderType>(["bedrock", "kimi"]);

export default function ProviderAvatar({ name, providerType, accentColor, size = 48 }: ProviderAvatarProps) {
  const color = accentColor || PROVIDER_TYPE_COLORS[providerType]
    || "var(--app-identity-provider-config-profile)";
  // accentColor 是用户自填数据，无法在此判明度，沿用白字
  const foreground = !accentColor && INK_ON_LIGHT_IDENTITY.has(providerType)
    ? "var(--app-identity-provider-ink)"
    : "#fff";
  const letter = name.charAt(0).toUpperCase() || "?";
  const fontSize = size * 0.42;

  return (
    <div
      className="shrink-0 rounded-xl flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: color,
        color: foreground,
        fontSize,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {letter}
    </div>
  );
}
