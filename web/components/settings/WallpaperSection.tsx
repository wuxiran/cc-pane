// 壁纸设置分区（仅 Tauri 桌面端注册；Web 端整块不渲染，门控在 SettingsPaneContent）。
// 阶段 1：静态图片。选文件走 plugin-dialog 的 open()（范例 LauncherInjectionRow），
// 导入后仅存 wallpapers_dir 下的受控相对文件名。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toastErr } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import WallpaperPreview from "@/components/settings/WallpaperPreview";
import { SearchableSetting } from "./SettingsSearchContext";
import {
  SettingsBlock,
  SettingsRangeControl,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./layout";
import { wallpaperService } from "@/services";
import { getErrorMessage } from "@/utils";
import type { WallpaperFit, WallpaperPowerSaver, WallpaperSettings } from "@/types";

interface WallpaperSectionProps {
  value: WallpaperSettings;
  onChange: (value: WallpaperSettings) => void;
}

const FIT_OPTIONS: WallpaperFit[] = ["cover", "contain", "tile", "center"];

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
    setPreviewUrl(null);
    if ((value.kind === "image" || value.kind === "video") && value.file) {
      wallpaperService
        .resolveWallpaperAsset(value.file, value.kind)
        .then((url) => {
          if (!cancelled) setPreviewUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPreviewUrl(null);
        });
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
      toastErr(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
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
      toastErr(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
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
      toastErr(t("wallpaperImportFailed", { error: getErrorMessage(err) }));
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
    id: string,
    label: string,
    current: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    apply: (v: number) => void,
    description?: string,
  ) {
    return (
      <SettingsRow
        title={label}
        description={description}
        htmlFor={id}
        control={(
          <SettingsRangeControl
            id={id}
            value={current}
            min={min}
            max={max}
            step={step}
            format={format}
            onChange={apply}
          />
        )}
      />
    );
  }

  const percent = (v: number) => `${Math.round(v * 100)}%`;
  const selectTriggerClass = "w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]";

  return (
    <>
      <SettingsSection title={t("wallpaper")} description={t("wallpaperDesc")}>
        <SettingsSwitchRow
          id="wallpaper-enabled"
          title={t("wallpaperEnabled")}
          checked={value.enabled}
          onCheckedChange={(checked) => update("enabled", checked)}
        />
        {/* 图片/视频选择 + 预览缩略图 */}
        <SettingsRow
          title={t("wallpaperImage")}
          description={t("wallpaperImageHint")}
          control={(
            <>
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
            </>
          )}
        >
          {previewUrl && value.kind === "video" ? (
            <video
              src={previewUrl}
              muted
              playsInline
              preload="metadata"
              className="h-20 w-32 rounded-md border border-[var(--app-border)] object-cover"
            />
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              className="h-20 w-32 rounded-md border border-[var(--app-border)] object-cover"
            />
          ) : (
            <div className="flex h-20 w-32 items-center justify-center rounded-md border border-dashed border-[var(--app-border)] text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
              {t("wallpaperNoImage")}
            </div>
          )}
        </SettingsRow>
        <SettingsRow
          title={t("wallpaperFit")}
          htmlFor="wallpaper-fit"
          control={(
            <Select value={value.fit} onValueChange={(next) => update("fit", next as WallpaperFit)}>
              <SelectTrigger id="wallpaper-fit" aria-label={t("wallpaperFit")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIT_OPTIONS.map((fit) => (
                  <SelectItem key={fit} value={fit}>{fitLabels[fit]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </SettingsSection>

      <SearchableSetting sectionId="wallpaper-sliders">
        <SettingsSection title={t("wallpaperGroups.effects")}>
          {/* 「壁纸浓度」调低是壁纸变淡，「终端底色浓度」调低是壁纸变清楚——
              两条方向相反，实测用户会把两条一起拉到最左，必须写明 */}
          {sliderRow("wallpaper-opacity", t("wallpaperOpacity"), value.opacity, 0.1, 1, 0.05, percent, (v) => update("opacity", v), t("wallpaperOpacityHint"))}
          {sliderRow("wallpaper-blur", t("wallpaperBlur"), value.blur, 0, 64, 1, (v) => `${v}px`, (v) => update("blur", v))}
          {sliderRow("wallpaper-dim", t("wallpaperDim"), value.dim, 0, 0.9, 0.05, percent, (v) => update("dim", v))}
          {sliderRow(
            "wallpaper-terminal-opacity",
            t("wallpaperTerminalOpacity"),
            value.terminalOpacity,
            0,
            1,
            0.05,
            percent,
            (v) => update("terminalOpacity", v),
            t("wallpaperTerminalOpacityHint"),
          )}
          {sliderRow(
            "wallpaper-glass-blur",
            t("wallpaperGlassBlur"),
            value.glassBlur,
            0,
            24,
            1,
            (v) => `${v}px`,
            (v) => update("glassBlur", v),
            t("wallpaperGlassBlurHint"),
          )}
          <SettingsBlock>
            <WallpaperPreview
              wallpaper={value}
              assetUrl={previewUrl}
              label={t("wallpaperPreview")}
            />
          </SettingsBlock>
        </SettingsSection>
      </SearchableSetting>

      {/* 视频选项 */}
      {value.kind === "video" && (
        <SettingsSection title={t("wallpaperGroups.video")}>
          <SettingsSwitchRow
            id="wallpaper-video-autoplay"
            title={t("wallpaperVideoAutoplay")}
            checked={value.video.autoplay}
            onCheckedChange={(checked) => update("video", { ...value.video, autoplay: checked })}
          />
          <SettingsSwitchRow
            id="wallpaper-video-pause-unfocused"
            title={t("wallpaperVideoPauseUnfocused")}
            checked={value.video.pauseWhenUnfocused}
            onCheckedChange={(checked) => update("video", { ...value.video, pauseWhenUnfocused: checked })}
          />
          <SettingsRow
            title={t("wallpaperVideoPowerSaver")}
            htmlFor="wallpaper-video-power-saver"
            control={(
              <Select
                value={value.video.powerSaver}
                onValueChange={(next) =>
                  update("video", { ...value.video, powerSaver: next as WallpaperPowerSaver })
                }
              >
                <SelectTrigger id="wallpaper-video-power-saver" aria-label={t("wallpaperVideoPowerSaver")} className={selectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("wallpaperVideoPowerSaver_auto")}</SelectItem>
                  <SelectItem value="always">{t("wallpaperVideoPowerSaver_always")}</SelectItem>
                  <SelectItem value="never">{t("wallpaperVideoPowerSaver_never")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          {sliderRow(
            "wallpaper-video-rate",
            t("wallpaperVideoRate"),
            value.video.playbackRate,
            0.25,
            2,
            0.25,
            (v) => `${v}x`,
            (v) => update("video", { ...value.video, playbackRate: v }),
          )}
        </SettingsSection>
      )}

      {/* 背景音乐 */}
      <SearchableSetting sectionId="wallpaper-music">
        <SettingsSection title={t("wallpaperGroups.music")}>
          <SettingsSwitchRow
            id="wallpaper-music-enabled"
            title={t("wallpaperMusicEnabled")}
            checked={value.music.enabled}
            onCheckedChange={(checked) => update("music", { ...value.music, enabled: checked })}
          />
          {/* 视频壁纸才有音轨可用；勾上后忽略下面的音乐文件 */}
          {value.music.enabled && value.kind === "video" && (
            <SettingsSwitchRow
              id="wallpaper-music-use-video-audio"
              title={t("wallpaperMusicUseVideoAudio")}
              description={t("wallpaperMusicUseVideoAudioHint")}
              checked={value.music.useVideoAudio}
              onCheckedChange={(checked) => update("music", { ...value.music, useVideoAudio: checked })}
            />
          )}
          {value.music.enabled && !(value.music.useVideoAudio && value.kind === "video") && (
            <SettingsRow
              title={t("wallpaperGroups.musicFile")}
              description={<span className="block max-w-[320px] truncate">{value.music.file ?? t("wallpaperMusicNoFile")}</span>}
              control={(
                <>
                  <Button size="sm" variant="secondary" disabled={importing} onClick={pickMusic}>
                    {t("wallpaperMusicPick")}
                  </Button>
                  {value.music.file && (
                    <Button size="sm" variant="ghost" onClick={clearMusic}>
                      {t("wallpaperClearImage")}
                    </Button>
                  )}
                </>
              )}
            />
          )}
          {value.music.enabled && sliderRow(
            "wallpaper-music-volume",
            t("wallpaperMusicVolume"),
            value.music.volume,
            0,
            1,
            0.05,
            percent,
            (v) => update("music", { ...value.music, volume: v }),
          )}
          {value.music.enabled && (
            <SettingsSwitchRow
              id="wallpaper-music-loop"
              title={t("wallpaperMusicLoop")}
              checked={value.music.loopPlayback}
              onCheckedChange={(checked) => update("music", { ...value.music, loopPlayback: checked })}
            />
          )}
          {value.music.enabled && (
            <SettingsSwitchRow
              id="wallpaper-music-autoplay"
              title={t("wallpaperMusicAutoplay")}
              checked={value.music.autoplay}
              onCheckedChange={(checked) => update("music", { ...value.music, autoplay: checked })}
            />
          )}
          {/* 独立于视频的同名开关：BGM 属全局氛围，失焦默认继续放 */}
          {value.music.enabled && (
            <SettingsSwitchRow
              id="wallpaper-music-pause-unfocused"
              title={t("wallpaperMusicPauseUnfocused")}
              description={t("wallpaperMusicPauseUnfocusedHint")}
              checked={value.music.pauseWhenUnfocused}
              onCheckedChange={(checked) => update("music", { ...value.music, pauseWhenUnfocused: checked })}
            />
          )}
        </SettingsSection>
      </SearchableSetting>
    </>
  );
}
