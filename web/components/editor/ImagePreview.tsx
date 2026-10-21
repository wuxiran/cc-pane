import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ZoomIn, ZoomOut, Maximize, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { filesystemService } from "@/services/filesystemService";
import { isTauriRuntime } from "@/services/runtime";
import EditorBreadcrumb from "./EditorBreadcrumb";

interface ImagePreviewProps {
  filePath: string;
  projectPath: string;
  sourceUrl?: string;
  sourceFileSize?: number;
  sourceLabel?: string;
  isRemote?: boolean;
  onNavigate?: (path: string) => void;
}

type ZoomMode = "fit" | "actual" | "custom";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExtensionLabel(filePath: string): string {
  const ext = filePath.split(".").pop()?.toUpperCase() || "";
  return ext;
}

export default function ImagePreview({
  filePath,
  projectPath,
  sourceUrl,
  sourceFileSize,
  sourceLabel,
  onNavigate,
  isRemote = Boolean(onNavigate),
}: ImagePreviewProps) {
  const { t } = useTranslation("editor");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [imgError, setImgError] = useState(false);
  const [retry, setRetry] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const assetUrl = sourceUrl ?? (isRemote ? null : isTauriRuntime() ? convertFileSrc(filePath) : `/api/fs/raw?path=${encodeURIComponent(filePath)}`);
  const extLabel = getExtensionLabel(filePath);

  // 获取文件大小
  useEffect(() => {
    let cancelled = false;
    setFileSize(null);
    if (sourceFileSize !== undefined) {
      setFileSize(sourceFileSize);
      return () => { cancelled = true; };
    }
    if (isRemote || sourceUrl) return;
    filesystemService.getEntryInfo(filePath).then((info) => {
      if (!cancelled) setFileSize(info.size);
    }).catch(() => {
      // Metadata is optional: an unreadable file must not retain another file's size.
      if (!cancelled) setFileSize(null);
    });
    return () => { cancelled = true; };
  }, [filePath, sourceFileSize, sourceUrl, isRemote, retry]);

  useEffect(() => {
    setImgError(false);
    setNaturalSize(null);
    setZoomMode("fit");
    setZoomLevel(1);
  }, [filePath, sourceUrl, isRemote]);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    }
    setImgError(false);
  }, []);

  const handleImageError = useCallback(() => {
    setImgError(true);
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoomMode("custom");
    setZoomLevel((prev) => Math.min(prev + ZOOM_STEP, ZOOM_MAX));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomMode("custom");
    setZoomLevel((prev) => Math.max(prev - ZOOM_STEP, ZOOM_MIN));
  }, []);

  const handleFitToView = useCallback(() => {
    setZoomMode("fit");
    setZoomLevel(1);
  }, []);

  const handleActualSize = useCallback(() => {
    setZoomMode("actual");
    setZoomLevel(1);
  }, []);

  // 根据 zoomMode 计算图片样式
  const getImageStyle = (): React.CSSProperties => {
    switch (zoomMode) {
      case "fit":
        return {
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain" as const,
        };
      case "actual":
        return {
          maxWidth: "none",
          maxHeight: "none",
          width: naturalSize ? naturalSize.w : "auto",
          height: naturalSize ? naturalSize.h : "auto",
        };
      case "custom":
        return {
          maxWidth: "none",
          maxHeight: "none",
          width: naturalSize ? naturalSize.w * zoomLevel : "auto",
          height: naturalSize ? naturalSize.h * zoomLevel : "auto",
        };
    }
  };

  const zoomPercent = zoomMode === "fit"
    ? "Fit"
    : `${Math.round((zoomMode === "actual" ? 1 : zoomLevel) * 100)}%`;

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ paddingTop: "var(--notch-bar-height, 0px)" }}>
      <EditorBreadcrumb filePath={filePath} projectPath={projectPath} isRemote={isRemote} sourceLabel={sourceLabel} onNavigate={onNavigate} />
      {/* 工具栏 */}
      {!imgError && <TooltipProvider delayDuration={300}>
        <div
          className="flex flex-wrap items-center gap-1 px-2 min-h-8 py-1 border-b text-xs shrink-0"
          style={{ background: "var(--editor-bg)" }}
        >
          {/* 格式 badge */}
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              background: "var(--app-accent-muted)",
              color: "var(--app-accent)",
            }}
          >
            {extLabel}
          </span>

          <div className="w-px h-4 bg-border mx-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                aria-label={t("zoomOut")}
                disabled={zoomMode === "custom" && zoomLevel <= ZOOM_MIN}
                onClick={handleZoomOut}
              >
                <ZoomOut size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("zoomOut")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                aria-label={t("zoomIn")}
                disabled={zoomMode === "custom" && zoomLevel >= ZOOM_MAX}
                onClick={handleZoomIn}
              >
                <ZoomIn size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("zoomIn")}</TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-border mx-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={zoomMode === "fit" ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                aria-label={t("fitToView")}
                aria-pressed={zoomMode === "fit"}
                onClick={handleFitToView}
              >
                <Maximize size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("fitToView")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={zoomMode === "actual" ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                aria-label={t("actualSize")}
                aria-pressed={zoomMode === "actual"}
                onClick={handleActualSize}
              >
                <Scan size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("actualSize")}</TooltipContent>
          </Tooltip>

          <div className="flex-1" />

          {/* 缩放信息 */}
          <span className="text-[11px] text-muted-foreground mr-2">
            {zoomPercent}
          </span>

          {/* 尺寸信息 */}
          {naturalSize && (
            <span className="text-[11px] text-muted-foreground mr-2">
              {naturalSize.w} × {naturalSize.h}
            </span>
          )}

          {/* 文件大小 */}
          {fileSize !== null && (
            <span className="text-[11px] text-muted-foreground">
              {formatFileSize(fileSize)}
            </span>
          )}
        </div>
      </TooltipProvider>}

      {/* 图片预览区域 - 棋盘格背景 */}
      {imgError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-sm text-muted-foreground" role="alert">
          <p>{t("imageLoadFailed", { defaultValue: "Failed to load image" })}</p>
          <Button variant="outline" size="sm" onClick={() => { setImgError(false); setRetry((value) => value + 1); }}>
            {t("retryImage", { defaultValue: "Retry" })}
          </Button>
        </div>
      ) : <div
        className="flex-1 min-h-0 overflow-auto flex"
        style={{
          backgroundImage:
            "linear-gradient(45deg, var(--checkerboard-color) 25%, transparent 25%), " +
            "linear-gradient(-45deg, var(--checkerboard-color) 25%, transparent 25%), " +
            "linear-gradient(45deg, transparent 75%, var(--checkerboard-color) 75%), " +
            "linear-gradient(-45deg, transparent 75%, var(--checkerboard-color) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
          backgroundColor: "var(--checkerboard-bg)",
        }}
      >
        <img
          key={`${filePath}:${retry}`}
          className="m-auto shrink-0"
          ref={imgRef}
          src={assetUrl ?? undefined}
          alt={filePath.split(/[/\\]/).pop() || "image"}
          style={getImageStyle()}
          onLoad={handleImageLoad}
          onError={handleImageError}
          draggable={false}
        />
      </div>}
    </div>
  );
}
