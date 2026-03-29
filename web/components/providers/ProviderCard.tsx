import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Star, Copy, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ProviderAvatar from "./ProviderAvatar";
import { PROVIDER_TYPE_META, type Provider, type ProviderType } from "@/types/provider";
import { PROVIDER_PRESETS } from "@/constants/providerPresets";

function getAccentColor(provider: Provider): string {
  const preset = PROVIDER_PRESETS.find(
    (p) => p.providerType === provider.providerType && provider.name.includes(p.nameKey.replace("preset", "").replace("Name", ""))
  );
  if (preset?.accentColor) return preset.accentColor;

  const TYPE_COLORS: Record<ProviderType, string> = {
    anthropic: "#E8590C", bedrock: "#FF9900", vertex: "#4285F4",
    proxy: "#6366F1", config_profile: "#6B7280", open_ai: "#10A37F",
    gemini: "#4285F4", opencode: "#8B5CF6",
  };
  return TYPE_COLORS[provider.providerType] || "#6B7280";
}

function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}***${key.slice(-3)}`;
}

/** 查找 Provider 对应的预设 website */
function getPresetWebsite(provider: Provider): string | undefined {
  const preset = PROVIDER_PRESETS.find(
    (p) => p.providerType === provider.providerType
  );
  return preset?.website;
}

interface ProviderCardProps {
  provider: Provider;
  onEdit: (p: Provider) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  onLaunch: (id: string) => void;
  onDuplicate: (p: Provider) => void;
}

export default function ProviderCard({ provider, onEdit, onDelete, onSetDefault, onLaunch, onDuplicate }: ProviderCardProps) {
  const { t } = useTranslation("settings");
  const accentColor = getAccentColor(provider);
  const meta = PROVIDER_TYPE_META[provider.providerType];
  const website = getPresetWebsite(provider);

  const handleCopyUrl = () => {
    if (provider.baseUrl) {
      navigator.clipboard.writeText(provider.baseUrl);
      toast.success("Copied");
    }
  };

  return (
    <div
      className="group relative rounded-lg transition-colors hover:bg-[var(--app-hover)]"
      style={{
        border: "1px solid var(--app-border)",
        borderLeft: provider.isDefault ? `4px solid ${accentColor}` : "1px solid var(--app-border)",
      }}
    >
      <div className="p-4 flex gap-4 items-center">
        {/* Avatar */}
        <ProviderAvatar
          name={provider.name}
          providerType={provider.providerType}
          accentColor={accentColor}
          size={48}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold truncate" style={{ color: "var(--app-text-primary)" }}>
              {provider.name}
            </span>
            {provider.isDefault && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 shrink-0"
                style={{ background: `color-mix(in srgb, ${accentColor} 15%, transparent)`, color: accentColor }}
              >
                {t("defaultBadge")}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "var(--app-text-tertiary)" }}>
            <span>{meta ? t(meta.labelKey) : provider.providerType}</span>
            {provider.apiKey && (
              <>
                <span className="opacity-40">·</span>
                <span className="font-mono text-[11px]">{maskApiKey(provider.apiKey)}</span>
              </>
            )}
          </div>

          {/* Website URL */}
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs hover:underline truncate block max-w-[300px]"
              style={{ color: "var(--app-text-link, var(--app-accent))" }}
              onClick={(e) => e.stopPropagation()}
            >
              {website}
            </a>
          )}

          {/* Base URL (if no website or different from website) */}
          {provider.baseUrl && provider.baseUrl !== website && (
            <button
              className="flex items-center gap-1 text-xs hover:underline cursor-pointer mt-0.5"
              style={{ color: "var(--app-text-tertiary)" }}
              onClick={handleCopyUrl}
              title="Copy URL"
            >
              <span className="truncate max-w-[300px]">{provider.baseUrl}</span>
              <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}
        </div>

        {/* Launch button */}
        <Button
          size="sm"
          className="h-8 px-3 text-xs shrink-0 text-white"
          style={{ background: "#16a34a", borderColor: "#16a34a" }}
          onClick={() => onLaunch(provider.id)}
        >
          <Play size={13} className="mr-1.5" fill="currentColor" />
          {t("launch")}
        </Button>

        {/* Action icons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(provider)}
            title={t("editBtn")}
          >
            <Pencil size={14} />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onDuplicate(provider)}
            title={t("duplicate")}
          >
            <Copy size={14} />
          </Button>
          {!provider.isDefault && (
            <Button
              variant="ghost" size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onSetDefault(provider.id)}
              title={t("setAsDefaultBtn")}
            >
              <Star size={14} />
            </Button>
          )}
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(provider.id)}
            title={t("deleteBtn")}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
