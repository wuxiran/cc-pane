// 壁纸设置分区（仅 Tauri 桌面端注册；Web 端整块不渲染，门控在 SettingsPanel）。
// 阶段 1：静态图片。选文件走 plugin-dialog 的 open()（范例 LauncherInjectionRow），
// 导入后仅存 wallpapers_dir 下的受控相对文件名。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import WallpaperSliderRow from "@/components/settings/WallpaperSliderRow";
import { wallpaperService } from "@/services";
import { getErrorMessage } from "@/utils";
import type { WallpaperFit, WallpaperPowerSaver, WallpaperSettings } from "@/types";

interface WallpaperSectionProps {
  value: WallpaperSettings;
  onChange: (value: WallpaperSettings) => void;
}

const FIT_OPTIONS: WallpaperFit[] = ["cover", "contain", "tile", "center"];

const selectStyle: React.CSSProperties = {
  background: "var(--app-input-bg)",
  border: "1px solid var(--app-border)",
  color: "var(--app-text-primary)",
};

export default function WallpaperSection({ value, onChange }: WallpaperSectionProps) {
  const { t } = useTranslation("settings");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  function update<K extends keyof WallpaperSettings>(key: K, v: WallpaperSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  const fitLabels: Record<WallpaperFit, string> = {
    cover: t("wallpaperFit_cover"),
    contain: t("wallpaperFit_contain"),
    tile: t("wallpaperFit_tile"),
    center: t("wallpaperFit_center"),
  };

  // 预览：settings 页内独立解析（与工作空间无关，看的是全局配置本身）
  useEffect(() => {
    let cancelled = false;
    if ((value.kind === "image" || value.kind === "video") && value.file) {
      wallpaperService
        .resolveWallpaperAsset(value.file, value.kind)
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
  }, [value.kind, value.file]);

  async function pickImage() {
    setImporting(true);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: t("wallpaperImageFilter"),
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"],
          },
        ],
      });
      if (typeof selected !== "string") return;
      const previousFile = value.kind === "image" ? value.file : null;
      const info = await wallpaperService.importWallpaper(selected, "image");
      onChange({ ...value, enabled: true, kind: "image", file: info.name });
      // 旧图已被替换：从壁纸库清掉，避免孤儿文件堆积
      if (previousFile && previousFile !== info.name) {
        await wallpaperService.removeWallpaper(previousFile).catch(() => {});
      }
    } catch (err) {
      toast.error(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
    } finally {
      setImporting(false);
    }
  }

  async function pickVideo() {
    setImporting(true);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: t("wallpaperVideoFilter"), extensions: ["mp4", "webm"] }],
      });
      if (typeof selected !== "string") return;
      const previousFile = value.file;
      const info = await wallpaperService.importWallpaper(selected, "video");
      onChange({ ...value, enabled: true, kind: "video", file: info.name });
      if (previousFile && previousFile !== info.name) {
        await wallpaperService.removeWallpaper(previousFile).catch(() => {});
      }
    } catch (err) {
      toast.error(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
    } finally {
      setImporting(false);
    }
  }

  async function pickMusic() {
    setImporting(true);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: t("wallpaperMusicFilter"),
            extensions: ["mp3", "m4a", "ogg", "wav", "flac"],
          },
        ],
      });
      if (typeof selected !== "string") return;
      const previousFile = value.music.file;
      const info = await wallpaperService.importWallpaper(selected, "audio");
      onChange({ ...value, music: { ...value.music, enabled: true, file: info.name } });
      if (previousFile && previousFile !== info.name) {
        await wallpaperService.removeWallpaper(previousFile).catch(() => {});
      }
    } catch (err) {
      toast.error(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
    } finally {
      setImporting(false);
    }
  }

  async function clearMusic() {
    const previousFile = value.music.file;
    onChange({ ...value, music: { ...value.music, enabled: false, file: null } });
    if (previousFile) {
      await wallpaperService.removeWallpaper(previousFile).catch(() => {});
    }
  }

  async function clearImage() {
    const previousFile = value.file;
    onChange({ ...value, enabled: false, kind: "none", file: null });
    if (previousFile) {
      await wallpaperService.removeWallpaper(previousFile).catch(() => {});
    }
  }

  function sliderRow(
    label: string,
    current: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    apply: (v: number) => void,
  ) {
    return (
      <WallpaperSliderRow
        label={label}
        value={current}
        min={min}
        max={max}
        step={step}
        format={format}
        onChange={apply}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs mb-1" style={{ color: "var(--app-text-tertiary)" }}>
        {t("wallpaperDesc")}
      </p>

      {/* 启用开关 */}
      <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
        <span>{t("wallpaperEnabled")}</span>
        <input
          type="checkbox"
          checked={value.enabled}
          className="h-4 w-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
          onChange={(event) => update("enabled", event.target.checked)}
        />
      </label>

      {/* 图片选择 + 预览 */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>{t("wallpaperImage")}</Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("wallpaperImageHint")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {previewUrl && value.kind === "video" ? (
            <video
              src={previewUrl}
              muted
              playsInline
              preload="metadata"
              className="h-20 w-32 rounded-md object-cover"
              style={{ border: "1px solid var(--app-border)" }}
            />
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              className="h-20 w-32 rounded-md object-cover"
              style={{ border: "1px solid var(--app-border)" }}
            />
          ) : (
            <div
              className="flex h-20 w-32 items-center justify-center rounded-md text-[11px]"
              style={{
                border: "1px dashed var(--app-border)",
                color: "var(--app-text-tertiary)",
              }}
            >
              {t("wallpaperNoImage")}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={importing} onClick={pickImage}>
              {t("wallpaperPickImage")}
            </Button>
            <Button size="sm" variant="secondary" disabled={importing} onClick={pickVideo}>
              {t("wallpaperPickVideo")}
            </Button>
            {value.file && (
              <Button size="sm" variant="ghost" onClick={clearImage}>
                {t("wallpaperClearImage")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 铺放方式 */}
      <div className="flex items-center justify-between gap-3">
        <Label>{t("wallpaperFit")}</Label>
        <select
          value={value.fit}
          className="h-9 w-40 rounded-md px-2 text-[13px] outline-none"
          style={selectStyle}
          onChange={(event) => update("fit", event.target.value as WallpaperFit)}
        >
          {FIT_OPTIONS.map((fit) => (
            <option key={fit} value={fit}>
              {fitLabels[fit]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
        {sliderRow(t("wallpaperOpacity"), value.opacity, 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => update("opacity", v))}
        {/* 「壁纸浓度」调低是壁纸变淡，「终端底色浓度」调低是壁纸变清楚——
            两条方向相反，实测用户会把两条一起拉到最左，必须写明 */}
        <p className="text-xs -mt-1" style={{ color: "var(--app-text-tertiary)" }}>
          {t("wallpaperOpacityHint")}
        </p>
        {sliderRow(t("wallpaperBlur"), value.blur, 0, 64, 1, (v) => `${v}px`, (v) => update("blur", v))}
        {sliderRow(t("wallpaperDim"), value.dim, 0, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => update("dim", v))}
        {sliderRow(
          t("wallpaperTerminalOpacity"),
          value.terminalOpacity,
          0,
          1,
          0.05,
          (v) => `${Math.round(v * 100)}%`,
          (v) => update("terminalOpacity", v),
        )}
        <p className="text-xs -mt-1" style={{ color: "var(--app-text-tertiary)" }}>
          {t("wallpaperTerminalOpacityHint")}
        </p>
        {sliderRow(
          t("wallpaperGlassBlur"),
          value.glassBlur,
          0,
          24,
          1,
          (v) => `${v}px`,
          (v) => update("glassBlur", v),
        )}
        <p className="text-xs -mt-1" style={{ color: "var(--app-text-tertiary)" }}>
          {t("wallpaperGlassBlurHint")}
        </p>
      </div>

      {/* 视频选项 */}
      {value.kind === "video" && (
        <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
          <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
            <span>{t("wallpaperVideoAutoplay")}</span>
            <input
              type="checkbox"
              checked={value.video.autoplay}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
              onChange={(event) => update("video", { ...value.video, autoplay: event.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
            <span>{t("wallpaperVideoPauseUnfocused")}</span>
            <input
              type="checkbox"
              checked={value.video.pauseWhenUnfocused}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
              onChange={(event) =>
                update("video", { ...value.video, pauseWhenUnfocused: event.target.checked })
              }
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <Label>{t("wallpaperVideoPowerSaver")}</Label>
            <select
              value={value.video.powerSaver}
              className="h-9 w-40 rounded-md px-2 text-[13px] outline-none"
              style={selectStyle}
              onChange={(event) =>
                update("video", {
                  ...value.video,
                  powerSaver: event.target.value as WallpaperPowerSaver,
                })
              }
            >
              <option value="auto">{t("wallpaperVideoPowerSaver_auto")}</option>
              <option value="always">{t("wallpaperVideoPowerSaver_always")}</option>
              <option value="never">{t("wallpaperVideoPowerSaver_never")}</option>
            </select>
          </div>
          {sliderRow(
            t("wallpaperVideoRate"),
            value.video.playbackRate,
            0.25,
            2,
            0.25,
            (v) => `${v}x`,
            (v) => update("video", { ...value.video, playbackRate: v }),
          )}
        </div>
      )}

      {/* 背景音乐 */}
      <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
        <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <span>{t("wallpaperMusicEnabled")}</span>
          <input
            type="checkbox"
            checked={value.music.enabled}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
            onChange={(event) => update("music", { ...value.music, enabled: event.target.checked })}
          />
        </label>
        {value.music.enabled && (
          <>
            {/* 视频壁纸才有音轨可用；勾上后忽略下面的音乐文件 */}
            {value.kind === "video" && (
              <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
                <span>
                  {t("wallpaperMusicUseVideoAudio")}
                  <span className="ml-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("wallpaperMusicUseVideoAudioHint")}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={value.music.useVideoAudio}
                  className="h-4 w-4 cursor-pointer"
                  style={{ accentColor: "var(--app-accent)" }}
                  onChange={(event) =>
                    update("music", { ...value.music, useVideoAudio: event.target.checked })
                  }
                />
              </label>
            )}
            {!(value.music.useVideoAudio && value.kind === "video") && (
              <div className="flex items-center justify-between gap-3">
                <span className="max-w-[280px] truncate text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                  {value.music.file ?? t("wallpaperMusicNoFile")}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={importing} onClick={pickMusic}>
                    {t("wallpaperMusicPick")}
                  </Button>
                  {value.music.file && (
                    <Button size="sm" variant="ghost" onClick={clearMusic}>
                      {t("wallpaperClearImage")}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {sliderRow(
              t("wallpaperMusicVolume"),
              value.music.volume,
              0,
              1,
              0.05,
              (v) => `${Math.round(v * 100)}%`,
              (v) => update("music", { ...value.music, volume: v }),
            )}
            <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
              <span>{t("wallpaperMusicLoop")}</span>
              <input
                type="checkbox"
                checked={value.music.loopPlayback}
                className="h-4 w-4 cursor-pointer"
                style={{ accentColor: "var(--app-accent)" }}
                onChange={(event) =>
                  update("music", { ...value.music, loopPlayback: event.target.checked })
                }
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
              <span>{t("wallpaperMusicAutoplay")}</span>
              <input
                type="checkbox"
                checked={value.music.autoplay}
                className="h-4 w-4 cursor-pointer"
                style={{ accentColor: "var(--app-accent)" }}
                onChange={(event) =>
                  update("music", { ...value.music, autoplay: event.target.checked })
                }
              />
            </label>
            {/* 独立于视频的同名开关：BGM 属全局氛围，失焦默认继续放 */}
            <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
              <span>
                {t("wallpaperMusicPauseUnfocused")}
                <span className="ml-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("wallpaperMusicPauseUnfocusedHint")}
                </span>
              </span>
              <input
                type="checkbox"
                checked={value.music.pauseWhenUnfocused}
                className="h-4 w-4 cursor-pointer"
                style={{ accentColor: "var(--app-accent)" }}
                onChange={(event) =>
                  update("music", { ...value.music, pauseWhenUnfocused: event.target.checked })
                }
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
