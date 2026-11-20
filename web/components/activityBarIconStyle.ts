// 实心图标配色：选中 = 主文字色 + 中性浅底（不再用强调色蓝底蓝字，实心块上发闷），
// 平时 = 次级文字色（--app-icon-inactive 对实心块偏灰，且全应用还有十几处在用，不动它）。
// 底色按主文字色混出，各主题深浅都成立。
export const ACTIVITY_ICON_ACTIVE =
  "text-[var(--app-text-primary)] bg-[color-mix(in_srgb,var(--app-text-primary)_12%,transparent)]";
export const ACTIVITY_ICON_IDLE =
  "text-[var(--app-text-secondary)] hover:bg-[color-mix(in_srgb,var(--app-text-primary)_7%,transparent)] hover:text-[var(--app-text-primary)]";
