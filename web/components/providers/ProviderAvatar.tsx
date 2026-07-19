import type { ProviderType } from "@/types/provider";

/**
 * Provider 类型的**身份色**（各家品牌色），仅用于头像等标识性元素。
 * 属 identity 语义，不参与主题 token —— 状态色一律用 `--app-accent` 等 token 表达。
 */
export const PROVIDER_TYPE_COLORS: Record<ProviderType, string> = {
  anthropic: "#E8590C",
  bedrock: "#FF9900",
  vertex: "#4285F4",
  proxy: "#6366F1",
  config_profile: "#6B7280",
  open_ai: "#10A37F",
  gemini: "#4285F4",
  kimi: "#F97316",
  glm: "#2563EB",
  opencode: "#8B5CF6",
  cursor: "#111827",
  grok: "#71767B",
};

interface ProviderAvatarProps {
  name: string;
  providerType: ProviderType;
  accentColor?: string;
  size?: number;
}

export default function ProviderAvatar({ name, providerType, accentColor, size = 48 }: ProviderAvatarProps) {
  const color = accentColor || PROVIDER_TYPE_COLORS[providerType] || "#6B7280";
  const letter = name.charAt(0).toUpperCase() || "?";
  const fontSize = size * 0.42;

  return (
    <div
      className="shrink-0 rounded-xl flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: color,
        color: "#fff",
        fontSize,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {letter}
    </div>
  );
}
