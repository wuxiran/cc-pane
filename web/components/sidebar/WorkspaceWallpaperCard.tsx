// 工作空间壁纸三态入口（inherit / custom / off），挂在运行环境 Sheet 底部。
// 即时保存（refreshWorkspace → saveWorkspace），独立于面板的 dirty 快照逻辑。
// custom 语义：以全局为底逐字段浅覆盖——阶段 1 仅覆盖图片本身，其余滑杆值回落全局。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useWorkspacesStore } from "@/stores";
import { wallpaperService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import type { Workspace, WorkspaceWallpaperOverrideMode } from "@/types";

interface WorkspaceWallpaperCardProps {
  workspace: Workspace;
}

const MODES: WorkspaceWallpaperOverrideMode[] = ["inherit", "custom", "off"];

export default function WorkspaceWallpaperCard({ workspace }: WorkspaceWallpaperCardProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const refreshWorkspace = useWorkspacesStore((state) => state.refreshWorkspace);
  const saveWorkspace = useWorkspacesStore((state) => state.saveWorkspace);
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const mode: WorkspaceWallpaperOverrideMode = workspace.wallpaperOverride?.mode ?? "inherit";
  const customFile =
    mode === "custom" ? (workspace.wallpaperOverride?.config?.file ?? null) : null;

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

  async function selectMode(nextMode: WorkspaceWallpaperOverrideMode) {
    if (nextMode === mode) return;
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
      )}
    </div>
  );
}
