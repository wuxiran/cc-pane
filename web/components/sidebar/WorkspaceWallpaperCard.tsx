// 工作空间壁纸三态入口（inherit / custom / off），挂在运行环境 Sheet 底部。
// 即时保存（refreshWorkspace → saveWorkspace），独立于面板的 dirty 快照逻辑。
//
// custom 语义：以全局为底**逐字段浅覆盖**——每个参数单独一个「覆盖」勾选框，
// 不勾 = 该字段不写进 config（回落全局），勾上才写。滑杆拖动期间走本地草稿 +
// 防抖落盘，避免每一步都打一次 saveWorkspace。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import WallpaperSliderRow, { formatPercent } from "@/components/settings/WallpaperSliderRow";
import { useWorkspacesStore, useSettingsStore } from "@/stores";
import { wallpaperService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { DEFAULT_WALLPAPER } from "@/utils/wallpaper";
import type {
  WallpaperOverrideConfig,
  WallpaperPowerSaver,
  WallpaperSettings,
  Workspace,
  WorkspaceWallpaperOverrideMode,
} from "@/types";

interface WorkspaceWallpaperCardProps {
  workspace: Workspace;
}

const MODES: WorkspaceWallpaperOverrideMode[] = ["inherit", "custom", "off"];
const SAVE_DEBOUNCE_MS = 300;

type NestedGroup = "video" | "music";

export default function WorkspaceWallpaperCard({ workspace }: WorkspaceWallpaperCardProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const refreshWorkspace = useWorkspacesStore((state) => state.refreshWorkspace);
  const saveWorkspace = useWorkspacesStore((state) => state.saveWorkspace);
  const globalWallpaper = useSettingsStore((state) => state.settings?.wallpaper);
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // 拖动中的未落盘配置：非 null 时优先于 workspace 上的持久值渲染
  const [draft, setDraft] = useState<WallpaperOverrideConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mode: WorkspaceWallpaperOverrideMode = workspace.wallpaperOverride?.mode ?? "inherit";
  const persisted = mode === "custom" ? (workspace.wallpaperOverride?.config ?? {}) : {};
  const config: WallpaperOverrideConfig = draft ?? persisted;
  const base: WallpaperSettings = globalWallpaper ?? DEFAULT_WALLPAPER;
  const customFile = mode === "custom" ? (config.file ?? null) : null;

  useEffect(() => {
    let cancelled = false;
    if (customFile) {
      wallpaperService
        .resolveWallpaperAsset(customFile, "image")
        .then((url) => {
          if (!cancelled) setPreviewUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPreviewUrl(null);
        });
    } else {
      setPreviewUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [customFile]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!isTauriRuntime()) return null;

  async function persist(mutate: (source: Workspace) => Workspace) {
    setSaving(true);
    try {
      const latest = (await refreshWorkspace(workspace.id)) ?? workspace;
      await saveWorkspace(mutate(latest));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  /** 立即更新草稿（UI 跟手），防抖后落盘 */
  function applyConfig(next: WallpaperOverrideConfig) {
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void persist((source) => ({
        ...source,
        wallpaperOverride: { mode: "custom", config: next },
      })).then(() => {
        // 期间没有新的改动才清草稿，否则会回跳到旧值
        if (!timerRef.current) setDraft(null);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  /** value 为 undefined = 取消覆盖（字段从 config 里删掉，回落全局） */
  function setTopField(key: keyof WallpaperOverrideConfig, value: unknown) {
    const next = { ...config } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = value;
    applyConfig(next as WallpaperOverrideConfig);
  }

  function setNestedField(group: NestedGroup, key: string, value: unknown) {
    const next = { ...config } as Record<string, unknown>;
    const nested = { ...((next[group] as Record<string, unknown> | undefined) ?? {}) };
    if (value === undefined) delete nested[key];
    else nested[key] = value;
    // 空对象要删掉，否则序列化出一个无意义的 {} 覆盖块
    if (Object.keys(nested).length === 0) delete next[group];
    else next[group] = nested;
    applyConfig(next as WallpaperOverrideConfig);
  }

  async function selectMode(nextMode: WorkspaceWallpaperOverrideMode) {
    if (nextMode === mode) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDraft(null);
    await persist((source) => ({
      ...source,
      wallpaperOverride:
        nextMode === "inherit"
          ? undefined
          : {
              mode: nextMode,
              config:
                nextMode === "custom" ? (source.wallpaperOverride?.config ?? null) : null,
            },
    }));
  }

  async function pickCustomImage() {
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: t("workspaceWallpaper.imageFilter", { ns: "sidebar", defaultValue: "图片" }),
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"],
          },
        ],
      });
      if (typeof selected !== "string") return;
      const previous = customFile;
      const info = await wallpaperService.importWallpaper(selected, "image");
      await persist((source) => ({
        ...source,
        wallpaperOverride: {
          mode: "custom",
          config: {
            ...source.wallpaperOverride?.config,
            enabled: true,
            kind: "image",
            file: info.name,
          },
        },
      }));
      if (previous && previous !== info.name) {
        await wallpaperService.removeWallpaper(previous).catch(() => {});
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  // off 文案避免用「关闭」：与 Sheet 的关闭按钮同名会干扰按钮定位（含测试选择器）
  const MODE_FALLBACKS: Record<WorkspaceWallpaperOverrideMode, string> = {
    inherit: "跟随全局",
    custom: "自定义",
    off: "不使用",
  };
  const modeLabel = (value: WorkspaceWallpaperOverrideMode) =>
    t(`workspaceWallpaper.mode_${value}`, {
      ns: "sidebar",
      defaultValue: MODE_FALLBACKS[value],
    });
  const label = (key: string, fallback: string) =>
    t(`workspaceWallpaper.${key}`, { ns: "sidebar", defaultValue: fallback });

  /** 覆盖开关 + 控件：不勾时控件禁用并显示全局值 */
  function overrideRow(
    overridden: boolean,
    onToggle: (checked: boolean) => void,
    control: React.ReactNode,
  ) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={overridden}
          aria-label={label("overrideField", "覆盖此项")}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <div className={`min-w-0 flex-1 ${overridden ? "" : "opacity-50"}`}>{control}</div>
      </div>
    );
  }

  function sliderField(
    key: "opacity" | "blur" | "dim" | "terminalOpacity" | "glassBlur",
    text: string,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ) {
    const overridden = config[key] !== undefined;
    const value = (config[key] as number | undefined) ?? base[key];
    return overrideRow(
      overridden,
      (checked) => setTopField(key, checked ? value : undefined),
      <WallpaperSliderRow
        label={text}
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        disabled={!overridden}
        className="w-28"
        onChange={(next) => setTopField(key, next)}
      />,
    );
  }

  function nestedSliderField(
    group: NestedGroup,
    key: string,
    text: string,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ) {
    const nested = config[group] as Record<string, unknown> | undefined;
    const overridden = nested?.[key] !== undefined;
    const value =
      (nested?.[key] as number | undefined) ??
      ((base[group] as unknown as Record<string, number>)[key] ?? 0);
    return overrideRow(
      overridden,
      (checked) => setNestedField(group, key, checked ? value : undefined),
      <WallpaperSliderRow
        label={text}
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        disabled={!overridden}
        className="w-28"
        onChange={(next) => setNestedField(group, key, next)}
      />,
    );
  }

  function nestedToggleField(group: NestedGroup, key: string, text: string) {
    const nested = config[group] as Record<string, unknown> | undefined;
    const overridden = nested?.[key] !== undefined;
    const value =
      (nested?.[key] as boolean | undefined) ??
      ((base[group] as unknown as Record<string, boolean>)[key] ?? false);
    return overrideRow(
      overridden,
      (checked) => setNestedField(group, key, checked ? value : undefined),
      <label className="flex items-center justify-between gap-3 text-[13px] text-[var(--app-text-primary)]">
        <span>{text}</span>
        <input
          type="checkbox"
          checked={value}
          disabled={!overridden}
          className="h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
          style={{ accentColor: "var(--app-accent)" }}
          onChange={(event) => setNestedField(group, key, event.target.checked)}
        />
      </label>,
    );
  }

  function powerSaverField() {
    const nested = config.video;
    const overridden = nested?.powerSaver !== undefined;
    const value = nested?.powerSaver ?? base.video.powerSaver;
    return overrideRow(
      overridden,
      (checked) => setNestedField("video", "powerSaver", checked ? value : undefined),
      <div className="flex items-center justify-between gap-3">
        <Label>{label("videoPowerSaver", "省电策略")}</Label>
        <select
          value={value}
          disabled={!overridden}
          className="h-8 w-28 rounded-md px-2 text-[12px] outline-none disabled:cursor-not-allowed"
          style={{
            background: "var(--app-input-bg)",
            border: "1px solid var(--app-border)",
            color: "var(--app-text-primary)",
          }}
          onChange={(event) =>
            setNestedField("video", "powerSaver", event.target.value as WallpaperPowerSaver)
          }
        >
          <option value="auto">{label("videoPowerSaver_auto", "自动")}</option>
          <option value="always">{label("videoPowerSaver_always", "始终省电")}</option>
          <option value="never">{label("videoPowerSaver_never", "始终播放")}</option>
        </select>
      </div>,
    );
  }

  const groupClass = "mt-3 flex flex-col gap-2 border-t border-[var(--app-border)] pt-3";
  const groupTitleClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]";

  return (
    <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
        {t("workspaceWallpaper.title", { ns: "sidebar", defaultValue: "壁纸" })}
      </p>
      <p className="mt-1 text-xs text-[var(--app-text-secondary)]">
        {t("workspaceWallpaper.hint", {
          ns: "sidebar",
          defaultValue: "工作空间可跟随全局壁纸、使用自己的壁纸，或明确关闭。",
        })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {MODES.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? "default" : "outline"}
            disabled={saving}
            onClick={() => void selectMode(value)}
          >
            {modeLabel(value)}
          </Button>
        ))}
      </div>
      {mode === "custom" && (
        <>
          <div className="mt-3 flex items-center gap-3">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className="h-14 w-24 rounded-md object-cover"
                style={{ border: "1px solid var(--app-border)" }}
              />
            ) : (
              <div
                className="flex h-14 w-24 items-center justify-center rounded-md text-[11px] text-[var(--app-text-tertiary)]"
                style={{ border: "1px dashed var(--app-border)" }}
              >
                {t("workspaceWallpaper.noImage", { ns: "sidebar", defaultValue: "未选择" })}
              </div>
            )}
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => void pickCustomImage()}>
              {t("workspaceWallpaper.pickImage", { ns: "sidebar", defaultValue: "选择图片…" })}
            </Button>
          </div>

          <div className={groupClass}>
            <p className={groupTitleClass}>{label("paramsTitle", "参数覆盖")}</p>
            <p className="text-xs text-[var(--app-text-secondary)]">
              {label("paramsHint", "勾选后该项按本工作空间生效，未勾选的回落全局设置。")}
            </p>
            {sliderField("opacity", label("opacity", "不透明度"), 0.1, 1, 0.05, formatPercent)}
            {sliderField("blur", label("blur", "模糊"), 0, 64, 1, (v) => `${v}px`)}
            {sliderField("dim", label("dim", "压暗"), 0, 0.9, 0.05, formatPercent)}
            {sliderField(
              "terminalOpacity",
              label("terminalOpacity", "终端不透明度"),
              0,
              1,
              0.05,
              formatPercent,
            )}
            {sliderField("glassBlur", label("glassBlur", "面板玻璃模糊"), 0, 24, 1, (v) => `${v}px`)}
          </div>

          <div className={groupClass}>
            <p className={groupTitleClass}>{label("videoTitle", "视频")}</p>
            {nestedToggleField("video", "autoplay", label("videoAutoplay", "自动播放"))}
            {nestedToggleField(
              "video",
              "pauseWhenUnfocused",
              label("videoPauseUnfocused", "失焦时暂停"),
            )}
            {nestedSliderField(
              "video",
              "playbackRate",
              label("videoRate", "播放速度"),
              0.25,
              2,
              0.25,
              (v) => `${v}x`,
            )}
            {powerSaverField()}
          </div>

          <div className={groupClass}>
            <p className={groupTitleClass}>{label("musicTitle", "背景音乐")}</p>
            {nestedToggleField("music", "enabled", label("musicEnabled", "启用"))}
            {nestedSliderField("music", "volume", label("musicVolume", "音量"), 0, 1, 0.05, formatPercent)}
            {nestedToggleField("music", "loopPlayback", label("musicLoop", "循环播放"))}
            {nestedToggleField("music", "autoplay", label("musicAutoplay", "自动播放"))}
            {nestedToggleField(
              "music",
              "pauseWhenUnfocused",
              label("musicPauseUnfocused", "失焦时暂停"),
            )}
            {nestedToggleField(
              "music",
              "useVideoAudio",
              label("musicUseVideoAudio", "用视频自带的声音"),
            )}
          </div>
        </>
      )}
    </div>
  );
}
