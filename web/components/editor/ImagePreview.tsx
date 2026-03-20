import { useState, useCallback, useRef, useEffect } from "react";
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
import EditorBreadcrumb from "./EditorBreadcrumb";

interface ImagePreviewProps {
  filePath: string;
  projectPath: string;
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

export default function ImagePreview({ filePath }: ImagePreviewProps) {
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [imgError, setImgError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const assetUrl = convertFileSrc(filePath);
  const extLabel = getExtensionLabel(filePath);

  // 获取文件大小
  useEffect(() => {
    let cancelled = false;
    filesystemService.getEntryInfo(filePath).then((info) => {
      if (!cancelled) setFileSize(info.size);
    }).catch(() => { /* 忽略 */ });
    return () => { cancelled = true; };
  }, [filePath]);

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
          width: naturalSize ? naturalSize.w : "auto",
          height: naturalSize ? naturalSize.h : "auto",
        };
      case "custom":
        return {
          width: naturalSize ? naturalSize.w * zoomLevel : "auto",
          height: naturalSize ? naturalSize.h * zoomLevel : "auto",
        };
    }
  };

  const zoomPercent = zoomMode === "fit"
    ? "Fit"
    : `${Math.round((zoomMode === "actual" ? 1 : zoomLevel) * 100)}%`;

  if (imgError) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <EditorBreadcrumb filePath={filePath} />
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          Failed to load image
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 工具栏 */}
      <TooltipProvider delayDuration={300}>
        <div
          className="flex items-center gap-1 px-2 h-[26px] border-b text-xs shrink-0"
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
                onClick={handleZoomOut}
              >
                <ZoomOut size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom Out</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleZoomIn}
              >
                <ZoomIn size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom In</TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-border mx-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={zoomMode === "fit" ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                onClick={handleFitToView}
              >
                <Maximize size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit to View</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={zoomMode === "actual" ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                onClick={handleActualSize}
              >
                <Scan size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>1:1 Actual Size</TooltipContent>
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
      </TooltipProvider>

      {/* 面包屑 */}
      <EditorBreadcrumb filePath={filePath} />

      {/* 图片预览区域 - 棋盘格背景 */}
      <div
        className="flex-1 overflow-auto flex items-center justify-center"
        style={{
          backgroundImage:
            "linear-gradient(45deg, var(--checkerboard-color, #e0e0e0) 25%, transparent 25%), " +
            "linear-gradient(-45deg, var(--checkerboard-color, #e0e0e0) 25%, transparent 25%), " +
            "linear-gradient(45deg, transparent 75%, var(--checkerboard-color, #e0e0e0) 75%), " +
            "linear-gradient(-45deg, transparent 75%, var(--checkerboard-color, #e0e0e0) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
          backgroundColor: "var(--checkerboard-bg, #ffffff)",
        }}
      >
        <img
          ref={imgRef}
          src={assetUrl}
          alt={filePath.split(/[/\\]/).pop() || "image"}
          style={getImageStyle()}
          onLoad={handleImageLoad}
          onError={handleImageError}
          draggable={false}
        />
      </div>
    </div>
  );
}
