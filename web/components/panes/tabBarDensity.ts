// 标签栏的三档密度配置（纯常量，从 TabBar 拆出以控制单文件体量）。
/** Notch 风格密度配置 */
// 标题不再单独限宽（min-w-0 flex-1 truncate 由 tabMaxW 统一约束）：
// 旧实现标题固定 max-w 且 `#N` 前缀算在预算内，normal 密度下实际只能显示 6~7 个字符。
export const DENSITY = {
  normal: {
    barPadding: 'px-2 pt-1',
    tabHeight: 'h-[34px]', tabPadding: 'px-3',
    tabRadius: 'rounded-t-[8px]', tabMaxW: 'max-w-[240px]', tabMinW: 'min-w-[112px]',
    inactiveRadius: 'rounded-t-[6px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[13px]',
    closeBtnSize: 'w-[22px] h-[22px]', closeIconSize: 13,
    separatorH: 'h-5',
    statusSize: 6, pinSize: 12, addBtn: 'p-2', addIcon: 'w-4 h-4',
  },
  compact: {
    barPadding: 'px-1.5 pt-0.5',
    tabHeight: 'h-[28px]', tabPadding: 'px-2.5',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[200px]', tabMinW: 'min-w-[94px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[12px]',
    closeBtnSize: 'w-[18px] h-[18px]', closeIconSize: 11,
    separatorH: 'h-4',
    statusSize: 5, pinSize: 10, addBtn: 'p-1.5', addIcon: 'w-3.5 h-3.5',
  },
  dense: {
    barPadding: 'px-1 pt-0.5',
    tabHeight: 'h-[24px]', tabPadding: 'px-2',
    tabRadius: 'rounded-t-[6px]', tabMaxW: 'max-w-[168px]', tabMinW: 'min-w-[74px]',
    inactiveRadius: 'rounded-t-[5px]', inactiveMargin: 'mx-0.5',
    fontSize: 'text-[11px]',
    closeBtnSize: 'w-[16px] h-[16px]', closeIconSize: 10,
    separatorH: 'h-3',
    statusSize: 4, pinSize: 10, addBtn: 'p-1', addIcon: 'w-3 h-3',
  },
} as const;

export type Density = keyof typeof DENSITY;
