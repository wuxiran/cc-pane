// 「原生配置」段里的快捷开关：常用键一键写进运行配置片段，不用手敲 TOML。
// 选「继承」= 从片段里删掉该键；其余选项 = 设置该键。改动经后端 `set_native_config_key`
// 只改目标键（Codex 保留注释与键顺序），结果写回草稿、随运行配置一起保存。
// 继承值来自「去掉本层片段」的那次预览：中转站有就显示中转站的值，否则是 CLI 自己的配置。
//
// 不放 `model_reasoning_effort`：CC-Panes 以显式字段托管它（启动时 `-c` 覆盖在片段之上）。
//
// Claude 暂不提供快捷开关：`alwaysThinkingEnabled` 与 CC-Panes 托管的推理强度
// （MAX_THINKING_TOKENS）语义重叠，需要时请直接写片段。
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLaunchProfilesStore } from "@/stores";
import type { LaunchProfileDraft, NativeConfigEntry, NativeConfigPreview, NativeOverrideTool } from "@/types";
import { withNativeOverride } from "./NativeOverrideEditor";

const PREVIEW_DELAY_MS = 300;
const INHERIT = "__inherit__";

/** segmented = 少量选项平铺；select = 选项较多时用下拉；number = 正整数输入，留空即继承。 */
type QuickKey =
  | { key: string; kind: "segmented" | "select"; options: readonly string[] }
  | { key: string; kind: "number" };

/** Codex `ReasoningEffort` 枚举（codex-rs protocol：none / minimal / low / medium / high / xhigh）。 */
const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** 每个 CLI 的快捷键。只放公开、与 CC-Panes 托管字段不重叠的键。 */
export const NATIVE_QUICK_KEYS: Record<NativeOverrideTool, readonly QuickKey[]> = {
  codex: [
    { key: "service_tier", kind: "segmented", options: ["fast", "flex"] },
    { key: "model_verbosity", kind: "segmented", options: ["low", "medium", "high"] },
    { key: "plan_mode_reasoning_effort", kind: "select", options: CODEX_REASONING_EFFORTS },
    { key: "model_auto_compact_token_limit", kind: "number" },
  ],
  claude: [],
};

interface NativeConfigQuickTogglesProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  tool: NativeOverrideTool;
  /** 当前草稿的生效预览（卡片已经在取，复用它读出本层的值）。 */
  preview: NativeConfigPreview | null;
}

/** 预览值是字面量（Codex 为 TOML、Claude 为 JSON）：字符串去引号，其余原样。 */
export function literalToText(literal: string): string {
  try {
    const parsed: unknown = JSON.parse(literal);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return literal;
  }
}

function findEntry(preview: NativeConfigPreview | null, key: string): NativeConfigEntry | undefined {
  return preview?.entries.find((entry) => entry.key === key);
}

/** 去掉运行配置这一层片段后的预览 = 这一层「继承」到的值。 */
function useInheritedPreview(draft: LaunchProfileDraft, tool: NativeOverrideTool, enabled: boolean) {
  const previewNativeConfig = useLaunchProfilesStore((s) => s.previewNativeConfig);
  const stripped = useMemo(
    () => ({ ...draft, nativeOverrides: withNativeOverride(draft.nativeOverrides, tool, "") }),
    [draft, tool],
  );
  const [inherited, setInherited] = useState<NativeConfigPreview | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      previewNativeConfig(stripped, tool)
        .then((result) => { if (!cancelled) setInherited(result); })
        .catch(() => { if (!cancelled) setInherited(null); });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stripped, tool, enabled, previewNativeConfig]);
  return inherited;
}

export default function NativeConfigQuickToggles({ draft, setDraft, tool, preview }: NativeConfigQuickTogglesProps) {
  const { t } = useTranslation("providers");
  const keys = NATIVE_QUICK_KEYS[tool];
  const inherited = useInheritedPreview(draft, tool, keys.length > 0);
  const setNativeConfigKey = useLaunchProfilesStore((s) => s.setNativeConfigKey);
  const [error, setError] = useState<string | null>(null);
  if (keys.length === 0) return null;

  const fragment = draft.nativeOverrides?.[tool] ?? "";
  const apply = (key: string, value: string | number | null) => {
    setNativeConfigKey(tool, fragment, key, value)
      .then((next) => {
        setError(null);
        // 请求期间用户又手改了片段：以手改为准，不拿旧原文算出的结果覆盖
        setDraft((current) => ((current.nativeOverrides?.[tool] ?? "") === fragment
          ? { ...current, nativeOverrides: withNativeOverride(current.nativeOverrides, tool, next) }
          : current));
      })
      .catch((reason) => setError(String(reason)));
  };

  return (
    <div className="space-y-2" data-testid="native-config-quick">
      <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("nativeConfig.quick.title")}</div>
      {keys.map((quick) => (
        <QuickKeyRow
          key={quick.key}
          quick={quick}
          own={findEntry(preview, quick.key)}
          inherited={findEntry(inherited, quick.key)}
          onChange={(value) => apply(quick.key, value)}
        />
      ))}
      {error ? (
        <p data-testid="native-config-quick-error" className="text-[length:var(--text-caption)] text-[var(--app-status-danger)]">
          {t("nativeConfig.quick.failed", { error })}
        </p>
      ) : null}
    </div>
  );
}

interface QuickKeyRowProps {
  quick: QuickKey;
  /** 当前草稿生效预览里的这一项（只认运行配置层的值为「本层已设置」）。 */
  own?: NativeConfigEntry;
  inherited?: NativeConfigEntry;
  onChange: (value: string | number | null) => void;
}

function QuickKeyRow({ quick, own, inherited, onChange }: QuickKeyRowProps) {
  const { t } = useTranslation("providers");
  const ownValue = own?.source === "profile" ? literalToText(own.value) : null;
  const inheritedText = inherited
    ? t("nativeConfig.quick.inheritedFrom", {
      source: t(`nativeConfig.source.${inherited.source}`),
      value: literalToText(inherited.value),
    })
    : t("nativeConfig.quick.inheritedNone");

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid={`native-config-quick-${quick.key}`}>
      <code className="w-36 shrink-0 truncate font-mono text-xs" style={{ color: "var(--app-text-primary)" }} title={quick.key}>
        {quick.key}
      </code>
      {quick.kind === "number" ? (
        <QuickNumberInput quickKey={quick.key} ownValue={ownValue} onChange={onChange} />
      ) : (
        <QuickChoice quick={quick} ownValue={ownValue} onChange={onChange} />
      )}
      <span
        data-testid={`native-config-quick-${quick.key}-inherited`}
        className="text-[length:var(--text-caption)]"
        style={{ color: "var(--app-text-tertiary)" }}
      >
        {inheritedText}
      </span>
    </div>
  );
}

interface QuickChoiceProps {
  quick: Extract<QuickKey, { options: readonly string[] }>;
  ownValue: string | null;
  onChange: (value: string | null) => void;
}

function QuickChoice({ quick, ownValue, onChange }: QuickChoiceProps) {
  const { t } = useTranslation("providers");
  const options = ownValue && !quick.options.includes(ownValue) ? [...quick.options, ownValue] : quick.options;
  const items = [
    { value: INHERIT, label: t("nativeConfig.quick.inherit") },
    ...options.map((option) => ({ value: option, label: option })),
  ];
  const handle = (value: string) => onChange(value === INHERIT ? null : value);
  if (quick.kind === "select") {
    return (
      <Select value={ownValue ?? INHERIT} onValueChange={handle}>
        <SelectTrigger size="sm" className="w-32" aria-label={quick.key}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  return (
    <SegmentedTabs size="sm" aria-label={quick.key} value={ownValue ?? INHERIT} items={items} onValueChange={handle} />
  );
}

interface QuickNumberInputProps {
  quickKey: string;
  ownValue: string | null;
  onChange: (value: number | null) => void;
}

/** 失焦 / 回车提交；留空 = 删掉该键（继承），非正整数不提交并提示。 */
function QuickNumberInput({ quickKey, ownValue, onChange }: QuickNumberInputProps) {
  const { t } = useTranslation("providers");
  const [text, setText] = useState(ownValue ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(ownValue ?? "");
    setInvalid(false);
  }, [ownValue]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === (ownValue ?? "")) return;
    if (trimmed === "") {
      setInvalid(false);
      onChange(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(parsed);
  };

  return (
    <>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        aria-label={quickKey}
        aria-invalid={invalid || undefined}
        placeholder={t("nativeConfig.quick.numberPlaceholder")}
        className="h-7 w-32 text-xs"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      {invalid ? (
        <span data-testid={`native-config-quick-${quickKey}-invalid`} className="text-[length:var(--text-caption)] text-[var(--app-status-danger)]">
          {t("nativeConfig.quick.invalidNumber")}
        </span>
      ) : null}
    </>
  );
}
