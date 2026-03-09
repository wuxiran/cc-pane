import { useEffect, useRef, useCallback, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { screenshotService } from "@/services";

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

function normalizeRect(rect: SelectionRect) {
  return {
    x: Math.min(rect.startX, rect.endX),
    y: Math.min(rect.startY, rect.endY),
    w: Math.abs(rect.endX - rect.startX),
    h: Math.abs(rect.endY - rect.startY),
  };
}

export default function ScreenshotSelector() {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading screenshot...");
  const [selection, setSelection] = useState<SelectionRect | null>(null);

  /** 临时文件路径（裁剪时传给后端） */
  const tempFilePathRef = useRef<string>("");
  /** DPI 比率：物理像素 / 逻辑像素 */
  const dpiRef = useRef(1);
  const selectingRef = useRef(false);
  const selectionRef = useRef<SelectionRect | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);

  // 组件挂载：由 JS 发起截图（push 模型）
  useEffect(() => {
    let cancelled = false;

    const doCapture = async () => {
      try {
        const result = await screenshotService.capture();
        if (cancelled) return;

        tempFilePathRef.current = result.tempFilePath;

        // 通过 asset protocol 加载临时 BMP 文件
        const url = screenshotService.getTempImageUrl(result.tempFilePath);

        // 预加载图片
        const img = new Image();
        img.src = url;

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Failed to load screenshot image"));
        });

        if (cancelled) return;

        imgElRef.current = img;
        // DPI 映射：img.naturalWidth = 物理像素，window.innerWidth = 逻辑像素
        dpiRef.current = img.naturalWidth / window.innerWidth;

        setImgSrc(url);
        setStatus("Drag to select region, ESC to cancel");

        // 图片就绪后显示窗口
        getCurrentWindow().show().catch(console.error);
      } catch (err) {
        if (!cancelled) {
          console.error("[screenshot] capture failed:", err);
          setStatus("Failed to capture screenshot. Press ESC to exit.");
        }
      }
    };

    doCapture();

    // 超时保护
    const timeout = setTimeout(() => {
      if (!imgElRef.current) {
        setStatus("Screenshot loading timeout. Press ESC to exit.");
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  // 鼠标按下开始选区
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!imgSrc) return;
    selectingRef.current = true;
    const rect = {
      startX: e.clientX,
      startY: e.clientY,
      endX: e.clientX,
      endY: e.clientY,
    };
    selectionRef.current = rect;
    setSelection(rect);
  }, [imgSrc]);

  // 鼠标移动更新选区
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!selectingRef.current || !selectionRef.current) return;
    const rect = {
      ...selectionRef.current,
      endX: e.clientX,
      endY: e.clientY,
    };
    selectionRef.current = rect;
    setSelection(rect);
  }, []);

  // 鼠标松开完成选区 — 先 hide 再裁剪（用户零等待）
  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (!selectingRef.current || !selectionRef.current) return;
    selectingRef.current = false;

    const finalSelection = {
      ...selectionRef.current,
      endX: e.clientX,
      endY: e.clientY,
    };
    selectionRef.current = finalSelection;
    setSelection(finalSelection);

    const { x, y, w, h } = normalizeRect(finalSelection);

    if (w < 5 || h < 5) {
      setStatus("Selection too small, drag again");
      return;
    }

    try {
      // 立即隐藏截图窗口（用户感知零延迟）
      const currentWin = getCurrentWindow();
      await currentWin.hide();

      // 将逻辑像素坐标映射到物理像素坐标
      const dpi = dpiRef.current;
      const imgX = Math.round(x * dpi);
      const imgY = Math.round(y * dpi);
      const imgW = Math.round(w * dpi);
      const imgH = Math.round(h * dpi);

      // 裁剪在后台进行
      const result = await screenshotService.cropAndSave(
        tempFilePathRef.current,
        imgX,
        imgY,
        imgW,
        imgH
      );

      // 复制路径到剪贴板
      await screenshotService.copyPathToClipboard(result.filePath);

      // 关闭截图窗口
      await currentWin.close();
    } catch (err) {
      console.error("Screenshot save failed:", err);
      // 出错时重新显示以便用户看到错误
      const currentWin = getCurrentWindow();
      await currentWin.show();
      setStatus(`Error: ${err}`);
    }
  }, []);

  // ESC 取消
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        await getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 计算 4-div 蒙层的位置
  const sel = selection ? normalizeRect(selection) : null;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        cursor: "crosshair",
        userSelect: "none",
        position: "fixed",
        top: 0,
        left: 0,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 层 1: 背景截图 — <img> 自动适配窗口尺寸 */}
      {imgSrc && (
        <img
          src={imgSrc}
          alt=""
          draggable={false}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            objectFit: "fill",
            pointerEvents: "none",
          }}
        />
      )}

      {/* 层 2: 4-div 半透明蒙层（围绕选区） */}
      {sel && sel.w > 0 && sel.h > 0 ? (
        <>
          {/* 上方蒙层 */}
          <div style={{
            position: "fixed", top: 0, left: 0,
            width: "100vw", height: sel.y,
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "none",
          }} />
          {/* 下方蒙层 */}
          <div style={{
            position: "fixed", top: sel.y + sel.h, left: 0,
            width: "100vw", height: `calc(100vh - ${sel.y + sel.h}px)`,
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "none",
          }} />
          {/* 左侧蒙层 */}
          <div style={{
            position: "fixed", top: sel.y, left: 0,
            width: sel.x, height: sel.h,
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "none",
          }} />
          {/* 右侧蒙层 */}
          <div style={{
            position: "fixed", top: sel.y, left: sel.x + sel.w,
            width: `calc(100vw - ${sel.x + sel.w}px)`, height: sel.h,
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "none",
          }} />
        </>
      ) : (
        /* 无选区时：全屏蒙层 */
        imgSrc && (
          <div style={{
            position: "fixed", top: 0, left: 0,
            width: "100vw", height: "100vh",
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "none",
          }} />
        )
      )}

      {/* 层 3: 选区边框 + 尺寸标签 */}
      {sel && sel.w > 0 && sel.h > 0 && (
        <>
          <div style={{
            position: "fixed",
            top: sel.y,
            left: sel.x,
            width: sel.w,
            height: sel.h,
            border: "2px solid #4fc3f7",
            pointerEvents: "none",
            boxSizing: "border-box",
          }} />
          {/* 尺寸标签（显示物理像素尺寸） */}
          <div style={{
            position: "fixed",
            top: sel.y > 25 ? sel.y - 25 : sel.y + sel.h + 5,
            left: sel.x,
            background: "rgba(0, 0, 0, 0.7)",
            color: "#fff",
            padding: "2px 8px",
            borderRadius: 3,
            fontSize: 13,
            fontFamily: "monospace",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}>
            {Math.round(sel.w * dpiRef.current)} x {Math.round(sel.h * dpiRef.current)}
          </div>
        </>
      )}

      {/* 底部状态文字 */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0, 0, 0, 0.7)",
          color: "#fff",
          padding: "8px 16px",
          borderRadius: 6,
          fontSize: 13,
          fontFamily: "monospace",
          pointerEvents: "none",
        }}
      >
        {status}
      </div>
    </div>
  );
}
