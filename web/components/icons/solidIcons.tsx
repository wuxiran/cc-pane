// 活动栏用的实心图标。lucide 只有线框款，这里复用它的几何（ISC，lucide-react 0.564）
// 做成实心：外形 = 填充 + 同色圆角描边（描边让轮廓与线框款同大、拐角同样圆润），
// 内部细节 = 遮罩镂空。走 mask 而不是用背景色画「假镂空」，这样悬停底色、
// 选中底色、任何主题下镂空处都透出真实背景。
import { useId, type SVGProps } from "react";

/**
 * fill    外形：填实 + 描边（描边宽 = 外描边宽）
 * line    实线：只描边（挂钩、连线这类没有面积的部件）
 * cut     镂空线：描边挖掉
 * hole    镂空面：填充挖掉
 * gap     外圈镂空：比 cut 粗，用来让叠放的部件之间留缝
 */
type Layer =
  | { kind: "fill" | "hole"; el: "path"; d: string }
  | { kind: "fill" | "hole"; el: "circle"; cx: number; cy: number; r: number }
  | { kind: "fill" | "hole"; el: "rect"; x: number; y: number; w: number; h: number; rx: number }
  | { kind: "line" | "cut" | "gap"; el: "path"; d: string }
  | { kind: "gap"; el: "circle"; cx: number; cy: number; r: number }
  | { kind: "gap"; el: "rect"; x: number; y: number; w: number; h: number; rx: number };

export interface SolidIconProps extends Omit<SVGProps<SVGSVGElement>, "strokeWidth"> {
  /** 外描边宽（viewBox 24 单位）。与线框款的 strokeWidth 同义，保持同一个轮廓尺寸。 */
  strokeWidth?: number;
}

export type SolidIcon = (props: SolidIconProps) => React.ReactElement;

function renderLayer(layer: Layer, index: number, outline: number) {
  const white = layer.kind === "fill" || layer.kind === "line";
  const color = white ? "#fff" : "#000";
  const filled = layer.kind === "fill" || layer.kind === "hole";
  // 实线比外描边粗半档：它们没有面积，和实心块放在一起时同宽会显得发虚
  const width =
    layer.kind === "gap"
      ? outline + 2
      : layer.kind === "cut"
        ? Math.max(1.25, outline * 0.85)
        : layer.kind === "line"
          ? outline + 0.5
          : outline;
  const paint = {
    fill: filled ? color : "none",
    stroke: layer.kind === "hole" ? "none" : color,
    strokeWidth: width,
  };
  if (layer.el === "circle") return <circle key={index} cx={layer.cx} cy={layer.cy} r={layer.r} {...paint} />;
  if (layer.el === "rect") {
    return <rect key={index} x={layer.x} y={layer.y} width={layer.w} height={layer.h} rx={layer.rx} {...paint} />;
  }
  return <path key={index} d={layer.d} {...paint} />;
}

function createSolidIcon(name: string, layers: readonly Layer[]): SolidIcon {
  function Icon({ strokeWidth = 1.5, className, ...rest }: SolidIconProps) {
    // React 的 useId 带「«»:」等字符，放进 url(#…) 不可靠，只留字母数字。
    const maskId = `solid-${name}-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={className}
        data-solid-icon={name}
        {...rest}
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
            <g strokeLinecap="round" strokeLinejoin="round">
              {layers.map((layer, index) => renderLayer(layer, index, strokeWidth))}
            </g>
          </mask>
        </defs>
        <rect x="-2" y="-2" width="28" height="28" fill="currentColor" mask={`url(#${maskId})`} />
      </svg>
    );
  }
  Icon.displayName = `Solid${name}`;
  return Icon;
}

const p = (kind: Layer["kind"], d: string) => ({ kind, el: "path", d }) as Layer;

export const SolidHouse = createSolidIcon("House", [
  p("fill", "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
  // 门：一直挖到底边外，底边描边也一起断开，像真的门洞
  p("hole", "M10 23v-8.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V23z"),
]);

export const SolidFolderTree = createSolidIcon("FolderTree", [
  p("fill", "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"),
  p("fill", "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"),
  p("line", "M3 5a2 2 0 0 0 2 2h3"),
  p("line", "M3 3v13a2 2 0 0 0 2 2h3"),
]);

export const SolidContact = createSolidIcon("Contact", [
  { kind: "fill", el: "rect", x: 3, y: 4, w: 18, h: 18, rx: 2 },
  p("line", "M8 2v2"),
  p("line", "M16 2v2"),
  { kind: "hole", el: "circle", cx: 12, cy: 11, r: 3 },
  p("hole", "M7 23v-3a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3z"),
]);

export const SolidBoxes = createSolidIcon("Boxes", [
  p("fill", "M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"),
  p("fill", "M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"),
  p("fill", "M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"),
  // 三只箱子之间的接缝 + 每只箱子的棱
  p("cut", "M7 10.5l5 3 5-3"),
  p("cut", "M12 13.5V19"),
  p("cut", "m7 16.5-4.74-2.85"),
  p("cut", "m7 16.5 5-3"),
  p("cut", "M7 16.5v5.17"),
  p("cut", "m17 16.5-5-3"),
  p("cut", "m17 16.5 4.74-2.85"),
  p("cut", "M17 16.5v5.17"),
  p("cut", "M12 8 7.26 5.15"),
  p("cut", "m12 8 4.74-2.85"),
  p("cut", "M12 13.5V8"),
]);

export const SolidLibrary = createSolidIcon("Library", [
  // 书脊加粗成实心书本，间距照线框款的 4 单位
  { kind: "fill", el: "rect", x: 3, y: 4, w: 2, h: 16, rx: 0.6 },
  { kind: "fill", el: "rect", x: 7, y: 8, w: 2, h: 12, rx: 0.6 },
  { kind: "fill", el: "rect", x: 11, y: 6, w: 2, h: 14, rx: 0.6 },
  p("fill", "m15.6 6.3 1.9-.55 3.6 13.95-1.9.55z"),
]);

export const SolidClapperboard = createSolidIcon("Clapperboard", [
  p("fill", "M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"),
  p("fill", "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"),
  p("cut", "m6.2 5.3 3.1 3.9"),
  p("cut", "m12.4 3.4 3.1 4"),
]);

export const SolidMonitorSmartphone = createSolidIcon("MonitorSmartphone", [
  { kind: "fill", el: "rect", x: 2, y: 4, w: 16, h: 11, rx: 2 },
  p("line", "M10 15v4"),
  p("line", "M7 19h5"),
  // 手机压在显示器右下角：先挖一圈缝，再画手机
  { kind: "gap", el: "rect", x: 16, y: 12, w: 6, h: 10, rx: 2 },
  { kind: "fill", el: "rect", x: 16, y: 12, w: 6, h: 10, rx: 2 },
]);

export const SolidNetwork = createSolidIcon("Network", [
  { kind: "fill", el: "rect", x: 16, y: 16, w: 6, h: 6, rx: 1 },
  { kind: "fill", el: "rect", x: 2, y: 16, w: 6, h: 6, rx: 1 },
  { kind: "fill", el: "rect", x: 9, y: 2, w: 6, h: 6, rx: 1 },
  p("line", "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"),
  p("line", "M12 12V8"),
]);

export const SolidListTodo = createSolidIcon("ListTodo", [
  { kind: "fill", el: "rect", x: 3, y: 4, w: 6, h: 6, rx: 1 },
  p("line", "M13 5h8"),
  p("line", "M13 12h8"),
  p("line", "M13 19h8"),
  p("line", "m3 17 2 2 4-4"),
]);

export const SolidBell = createSolidIcon("Bell", [
  p("fill", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"),
  p("fill", "M10.268 21a2 2 0 0 0 3.464 0z"),
]);

export const SolidHistory = createSolidIcon("History", [
  p("fill", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"),
  p("line", "M3 3v5h5"),
  p("cut", "M12 7v5l4 2"),
]);

export const SolidCalendarClock = createSolidIcon("CalendarClock", [
  { kind: "fill", el: "rect", x: 3, y: 4, w: 18, h: 18, rx: 2 },
  p("line", "M8 2v4"),
  p("line", "M16 2v4"),
  p("cut", "M3 10h7"),
  // 时钟压在日历右下角：挖缝后单独画
  { kind: "gap", el: "circle", cx: 16, cy: 16, r: 6 },
  { kind: "fill", el: "circle", cx: 16, cy: 16, r: 6 },
  p("cut", "M16 13.5v2.7l1.8 1.1"),
]);

export const SolidSettings = createSolidIcon("Settings", [
  p("fill", "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"),
  { kind: "hole", el: "circle", cx: 12, cy: 12, r: 3 },
]);

export const SolidPlus = createSolidIcon("Plus", [
  p("line", "M5 12h14"),
  p("line", "M12 5v14"),
]);
