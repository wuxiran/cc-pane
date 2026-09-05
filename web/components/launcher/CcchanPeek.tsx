// cc酱露脸（克制版）：启动器角落的小尺寸静态形象 + 极轻呼吸浮动。
// 形象来源：web/ccchan/ 的桌宠本体是像素风超级英雄精灵图（SpritePet 光栅 atlas，
// 64px 单元格逐帧动画），直接复用过重。这里提取其配色语言画极简矢量变体——
// 蓝衣（var(--primary) 圆角方块脸）+ 白眼睛/微笑（var(--primary-foreground)）
// + 红色小披风（var(--app-status-danger)，呼应精灵图的红披风），全部 token 化、禁裸 hex。
// 动画：translateY 2px / 2.4s / var(--ease-in-out)，Tailwind 任意值类引用本组件内
// 注入的 keyframes（不改 index.css）；motion-reduce 下静止。纯装饰，aria-hidden。

/** 呼吸浮动关键帧：上浮 2px 后回落，2.4s 一循环。组件内联注入，避免改全局 CSS。 */
const CCCHAN_PEEK_KEYFRAMES = `
@keyframes ccchan-peek-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
`;

export interface CcchanPeekProps {
  className?: string;
}

export default function CcchanPeek({ className }: CcchanPeekProps) {
  return (
    <span
      aria-hidden="true"
      data-ccchan-peek
      className={`inline-block select-none animate-[ccchan-peek-float_2.4s_var(--ease-in-out)_infinite] motion-reduce:animate-none ${className ?? ""}`}
    >
      <style>{CCCHAN_PEEK_KEYFRAMES}</style>
      <svg viewBox="0 0 32 32" className="h-7 w-7" focusable="false">
        {/* 小披风：精灵图的红披风意象，露一角即可 */}
        <path d="M7 15 L3 27 L11 25 Z" fill="var(--app-status-danger)" fillOpacity={0.9} />
        {/* 圆角方块脸：蓝衣主色 */}
        <rect x="6" y="4" width="20" height="20" rx="6" fill="var(--primary)" />
        {/* 眼睛 + 微笑：前景撞色，与 fallback 精灵的白眼白嘴一致 */}
        <circle cx="12.5" cy="12" r="2" fill="var(--primary-foreground)" />
        <circle cx="19.5" cy="12" r="2" fill="var(--primary-foreground)" />
        <path
          d="M12.5 17.5 Q16 20 19.5 17.5"
          fill="none"
          stroke="var(--primary-foreground)"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
