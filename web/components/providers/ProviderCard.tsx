import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Copy, MonitorCog, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import ProviderAvatar, { PROVIDER_TYPE_COLORS } from "./ProviderAvatar";
import { PROVIDER_TYPE_META, isSystemProvider, type Provider } from "@/types/provider";
import { PROVIDER_PRESETS } from "@/constants/providerPresets";

/**
 * Provider 的**身份色**（品牌色），仅用于头像等标识性元素。
 * 状态（默认/激活）一律走 `--app-accent`，不得借身份色表达。
 */
function getAccentColor(provider: Provider): string {
  // 按 providerType 匹配预设。旧实现拿 i18n key 裁剪去比对用户自定义名称，几乎必然失配。
  const preset = PROVIDER_PRESETS.find((p) => p.providerType === provider.providerType);
  return preset?.accentColor || PROVIDER_TYPE_COLORS[provider.providerType] || "#6B7280";
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

/** 系统条目的宿主探测明细（仅「系统环境变量」卡片使用） */
export interface SystemProbeInfo {
  /** 命中的宿主 Anthropic 环境变量名（不含值） */
  envKeys: string[];
  /** 探测到 cc-switch 配置库 */
  ccSwitch: boolean;
  /** 当前运行环境是本机——否则该宿主级探测不代表目标环境 */
  runtimeApplicable: boolean;
  /** 非本机时展示的运行环境名，如 "WSL" / "SSH" */
  runtimeLabel?: string;
}

interface ProviderCardProps {
  provider: Provider;
  onEdit: (p: Provider) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  onDuplicate: (p: Provider) => void;
  systemProbe?: SystemProbeInfo;
}

/** 卡片外框：默认态用 `--app-accent` 左边条表达（文档 §1 激活态约定，非身份色） */
function cardShellStyle(isDefault: boolean): React.CSSProperties {
  return {
    border: "1px solid var(--app-border)",
    borderLeft: isDefault ? "3px solid var(--app-accent)" : "1px solid var(--app-border)",
    boxShadow: "var(--sh-sm)",
  };
}

const CARD_SHELL_CLASS =
  "group relative rounded-lg rounded-r-md transition-[background-color,box-shadow] duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:shadow-[var(--sh-md)]";

/** 「设为默认」主操作：非默认为文字按钮，已默认为不可点的状态标识 */
function DefaultAction({
  isDefault,
  onSetDefault,
  label,
  defaultLabel,
}: {
  isDefault: boolean;
  onSetDefault: () => void;
  label: string;
  defaultLabel: string;
}) {
  if (isDefault) {
    return (
      <span
        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs shrink-0 select-none"
        style={{
          background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
          color: "var(--app-accent)",
        }}
      >
        <Check size={13} />
        {defaultLabel}
      </span>
    );
  }
  return (
    <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shrink-0" onClick={onSetDefault}>
      {label}
    </Button>
  );
}

export default function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onSetDefault,
  onDuplicate,
  systemProbe,
}: ProviderCardProps) {
  const { t } = useTranslation("settings");

  // 合成「系统环境变量」条目：无凭证、不可编辑/删除，仅可设为默认（选它 = 不注入、跟随系统/cc-switch）。
  if (isSystemProvider(provider.id)) {
    const detected = [
      ...(systemProbe?.ccSwitch ? [t("systemEnvCcSwitch")] : []),
      ...(systemProbe?.envKeys ?? []),
    ];
    return (
      <div className={CARD_SHELL_CLASS} style={cardShellStyle(provider.isDefault)}>
        <div className="p-3 flex gap-3 items-center">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: "color-mix(in srgb, var(--app-accent) 14%, transparent)",
              color: "var(--app-accent)",
            }}
          >
            <MonitorCog size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate mb-1" style={{ color: "var(--app-text-primary)" }}>
              {provider.name}
            </div>
            <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("systemProviderDesc")}
            </div>
            {/* 探测明细：只展示命中的变量名，绝不展示值 */}
            <div className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
              {detected.length > 0
                ? t("systemEnvDetected", { keys: detected.join(", ") })
                : t("systemEnvNone")}
            </div>
            {/* 宿主进程级探测在 WSL/SSH 下不代表目标环境 */}
            {systemProbe && !systemProbe.runtimeApplicable && (
              <div
                className="flex items-start gap-1 text-xs mt-1"
                style={{ color: "var(--app-warning)" }}
              >
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  {t("systemEnvRuntimeWarning", { runtime: systemProbe.runtimeLabel ?? "" })}
                </span>
              </div>
            )}
          </div>
          <DefaultAction
            isDefault={provider.isDefault}
            onSetDefault={() => onSetDefault(provider.id)}
            label={t("setAsDefaultBtn")}
            defaultLabel={t("defaultBadge")}
          />
        </div>
      </div>
    );
  }

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
    <div className={CARD_SHELL_CLASS} style={cardShellStyle(provider.isDefault)}>
      <div className="p-3 flex gap-3 items-center">
        {/* Avatar（身份色） */}
        <ProviderAvatar
          name={provider.name}
          providerType={provider.providerType}
          accentColor={accentColor}
          size={40}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate mb-1" style={{ color: "var(--app-text-primary)" }}>
            {provider.name}
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
            <IconTooltipButton
              label="Copy URL"
              className="flex items-center gap-1 text-xs hover:underline mt-0.5 p-0 text-[var(--app-text-tertiary)] hover:bg-transparent"
              onClick={handleCopyUrl}
            >
              <span className="truncate max-w-[300px]">{provider.baseUrl}</span>
              <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            </IconTooltipButton>
          )}
        </div>

        {/* 主操作：设为默认 */}
        <DefaultAction
          isDefault={provider.isDefault}
          onSetDefault={() => onSetDefault(provider.id)}
          label={t("setAsDefaultBtn")}
          defaultLabel={t("defaultBadge")}
        />

        {/* CRUD：hover 才现 */}
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconTooltipButton label={t("editBtn")} className="h-7 w-7" onClick={() => onEdit(provider)}>
            <Pencil size={14} />
          </IconTooltipButton>
          <IconTooltipButton label={t("duplicate")} className="h-7 w-7" onClick={() => onDuplicate(provider)}>
            <Copy size={14} />
          </IconTooltipButton>
          <IconTooltipButton
            label={t("deleteBtn")}
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(provider.id)}
          >
            <Trash2 size={14} />
          </IconTooltipButton>
        </div>
      </div>
    </div>
  );
}
