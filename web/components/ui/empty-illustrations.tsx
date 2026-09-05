// 空态插画体系：一组轻量线稿 SVG，供 EmptyState 等空态场景按语义复用。
// 约束：stroke 主体 currentColor（颜色由父级 text-* / style color 控制）；
// 每张插画挑 1-2 个视觉节点（文件占位线、终端光标、镜片反光点等）用
// var(--primary) 点缀，与品牌主色接上；其余填充只用 token 色或 none，禁裸 hex；
// 统一 1.5px 线宽、圆角线帽/线脚；viewBox 统一 96×96，展示尺寸由 className 控制。
// 插画为纯装饰，一律 aria-hidden，不承载语义——语义由 EmptyState 的文案表达。
import type { ComponentType } from "react";

export interface EmptyIllustrationProps {
  className?: string;
}

export type EmptyIllustrationComponent = ComponentType<EmptyIllustrationProps>;

/** 品牌主色点缀：每张插画 1-2 个节点的 accent，统一走 --primary token。 */
const ACCENT = "var(--primary)";

/** 柔和背景圆：唯一使用 token 填充的元素，让线稿在深浅主题下都有一致衬底。 */
function Backdrop() {
  return <circle cx="48" cy="48" r="42" fill="var(--app-text-primary)" fillOpacity={0.04} />;
}

interface IllustrationFrameProps extends EmptyIllustrationProps {
  name: string;
  children: React.ReactNode;
}

function IllustrationFrame({ name, className, children }: IllustrationFrameProps) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-illustration={name}
    >
      <Backdrop />
      {children}
    </svg>
  );
}

/** empty-folder：目录/文件为空（文件树、项目无文件）。 */
export function EmptyFolderIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="empty-folder" className={className}>
      <path d="M20 34a4 4 0 0 1 4-4h15l7 8h26a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V34z" />
      <path d="M20 46h56" />
      {/* 点缀：文件占位虚线（缺失内容的位置提示）接品牌主色 */}
      <path d="M36 58h24" stroke={ACCENT} strokeDasharray="2 6" />
    </IllustrationFrame>
  );
}

/** empty-terminal：无终端/无面板（分屏空槽、终端未启动）。 */
export function EmptyTerminalIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="empty-terminal" className={className}>
      <rect x="18" y="26" width="60" height="44" rx="6" />
      <path d="M18 36h60" />
      {/* 点缀：窗口灯 + 终端光标接品牌主色 */}
      <circle cx="25" cy="31" r="0.6" fill={ACCENT} stroke="none" />
      <circle cx="31" cy="31" r="0.6" fill="currentColor" stroke="none" />
      <path d="M28 46l8 6-8 6" />
      <path d="M44 60h12" stroke={ACCENT} />
    </IllustrationFrame>
  );
}

/** empty-search：搜索/筛选无结果。 */
export function EmptySearchIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="empty-search" className={className}>
      <circle cx="44" cy="44" r="18" />
      <path d="M57 57l13 13" />
      <path d="M37 44h14" strokeDasharray="2 5" />
      {/* 点缀：镜片反光点接品牌主色 */}
      <circle cx="37.5" cy="37.5" r="1.2" fill={ACCENT} stroke="none" />
    </IllustrationFrame>
  );
}

/** empty-history：无历史记录（会话历史、版本历史、启动记录）。 */
export function EmptyHistoryIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="empty-history" className={className}>
      <path d="M30 40a20 20 0 1 1-2 14" />
      <path d="M28 32v8h8" />
      {/* 点缀：时钟指针接品牌主色 */}
      <path d="M48 40v10l7 5" stroke={ACCENT} />
    </IllustrationFrame>
  );
}

/** empty-box：通用空（列表为空、暂无内容等兜底语义）。 */
export function EmptyBoxIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="empty-box" className={className}>
      <path d="M48 24l28 14-28 14-28-14 28-14z" />
      <path d="M20 38v22l28 14 28-14V38" />
      <path d="M48 52v22" />
      {/* 点缀：箱盖折痕虚线接品牌主色 */}
      <path d="M62 31l-28 14" stroke={ACCENT} strokeDasharray="2 5" />
    </IllustrationFrame>
  );
}

/** error-cloud：加载失败/离线等错误空态（非阻断性，可配重试动作）。 */
export function ErrorCloudIllustration({ className }: EmptyIllustrationProps) {
  return (
    <IllustrationFrame name="error-cloud" className={className}>
      <path d="M33 68h31a11 11 0 0 0 1.7-21.9A17 17 0 0 0 31 41.6 12.5 12.5 0 0 0 33 68z" />
      {/* 点缀：感叹号（线 + 点）接品牌主色 */}
      <path d="M48 46v9" stroke={ACCENT} />
      <circle cx="48" cy="61" r="0.6" fill={ACCENT} stroke="none" />
    </IllustrationFrame>
  );
}

/** 语义名 → 插画组件。语义名供 EmptyState 的 illustration prop 使用。 */
export const EMPTY_ILLUSTRATIONS = {
  "empty-folder": EmptyFolderIllustration,
  "empty-terminal": EmptyTerminalIllustration,
  "empty-search": EmptySearchIllustration,
  "empty-history": EmptyHistoryIllustration,
  "empty-box": EmptyBoxIllustration,
  "error-cloud": ErrorCloudIllustration,
} as const;

export type EmptyIllustrationName = keyof typeof EMPTY_ILLUSTRATIONS;
