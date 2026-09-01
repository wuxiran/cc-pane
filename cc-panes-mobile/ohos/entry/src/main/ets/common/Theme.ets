/**
 * 主题与 UI 自适应状态（对齐 Flutter 版 teal 种子配色 + 明暗两套色板）。
 *
 * - 色彩决策集中在 ThemeColors，组件统一经 currentTheme() 取色，禁止散落硬编码；
 * - colorMode / breakpoint 以 @ObservedV2 + @Trace 的 ThemeState 为响应式数据源，
 *   同时镜像写入 AppStorage（'colorMode' / 'breakpoint'）供跨层只读；
 * - EntryAbility.onConfigurationUpdate → applyColorMode()，首页媒体查询 → applyBreakpoint()。
 */

/** 终端底色常量（xterm 深底，明暗共用）。 */
export const TERMINAL_BG: string = '#1E1E1E';

/** 一套色板（Material teal #009688 系种子派生）。 */
export class ThemeColors {
  readonly background: string;
  readonly card: string;
  readonly headerBg: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly divider: string;
  readonly badgeBg: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly primaryDim: string;
  readonly tertiary: string;
  readonly tertiaryDim: string;
  readonly error: string;
  readonly errorDim: string;
  readonly staleText: string;
  readonly staleDim: string;

  constructor(
    background: string,
    card: string,
    headerBg: string,
    textPrimary: string,
    textSecondary: string,
    divider: string,
    badgeBg: string,
    primary: string,
    onPrimary: string,
    primaryDim: string,
    tertiary: string,
    tertiaryDim: string,
    error: string,
    errorDim: string,
    staleText: string,
    staleDim: string
  ) {
    this.background = background;
    this.card = card;
    this.headerBg = headerBg;
    this.textPrimary = textPrimary;
    this.textSecondary = textSecondary;
    this.divider = divider;
    this.badgeBg = badgeBg;
    this.primary = primary;
    this.onPrimary = onPrimary;
    this.primaryDim = primaryDim;
    this.tertiary = tertiary;
    this.tertiaryDim = tertiaryDim;
    this.error = error;
    this.errorDim = errorDim;
    this.staleText = staleText;
    this.staleDim = staleDim;
  }
}

const LIGHT: ThemeColors = new ThemeColors(
  '#F6FAF8', '#FFFFFF', '#EAF0ED', '#191D1B', '#4A544F', '#DFE7E3', '#E4EAE7',
  '#00796B', '#FFFFFF', '#1F00796B', '#8A6D1C', '#1F8A6D1C', '#BA1A1A', '#1FBA1A1A', '#9C6D00', '#1FFF9800'
);

const DARK: ThemeColors = new ThemeColors(
  '#101413', '#1A1E1D', '#222725', '#E2E6E4', '#AFB9B5', '#3A423F', '#2C3130',
  '#4DB6AC', '#003733', '#1F4DB6AC', '#E3C36A', '#1FE3C36A', '#FFB4AB', '#1FFFB4AB', '#FFC66B', '#1FFF9800'
);

/** 全局 UI 自适应状态（@ComponentV2 内直接读属性即可响应刷新）。 */
@ObservedV2
export class ThemeState {
  /** 'light' | 'dark'，缺省 dark（对齐 Flutter 暗色默认观感）。 */
  @Trace colorMode: string = 'dark';

  /** 'sm' | 'md' | 'lg' | 'xl'（sm <600 / md 600-840 / lg 840-1280 / xl ≥1280，xs 归入 sm），缺省 sm。 */
  @Trace breakpoint: string = 'sm';
}

let stateInstance: ThemeState | undefined = undefined;

export function themeState(): ThemeState {
  if (stateInstance === undefined) {
    stateInstance = new ThemeState();
  }
  return stateInstance;
}

/** EntryAbility 系统深浅色变化时调用（同时镜像到 AppStorage 'colorMode'）。 */
export function applyColorMode(mode: string): void {
  let normalized: string = mode === 'light' ? 'light' : 'dark';
  themeState().colorMode = normalized;
  AppStorage.setOrCreate('colorMode', normalized);
}

/** 首页媒体查询断点变化时调用（同时镜像到 AppStorage 'breakpoint'）。 */
export function applyBreakpoint(breakpoint: string): void {
  let normalized: string =
    breakpoint === 'xl' ? 'xl' : breakpoint === 'lg' ? 'lg' : breakpoint === 'md' ? 'md' : 'sm';
  themeState().breakpoint = normalized;
  AppStorage.setOrCreate('breakpoint', normalized);
}

/**
 * 当前色板：按 AppStorage 'colorMode'（'light'|'dark'，缺省 dark）取。
 * build 中调用会建立对 ThemeState.colorMode 的渲染依赖，深浅色切换即时生效。
 */
export function currentTheme(): ThemeColors {
  let watched: string = themeState().colorMode;
  let stored: string | undefined = AppStorage.get<string>('colorMode');
  let mode: string = stored !== undefined && stored.length > 0 ? stored : watched;
  return mode === 'light' ? LIGHT : DARK;
}

/** 当前断点：'sm' | 'md' | 'lg' | 'xl'（xs 归入 sm，Tab 栏等行为只看 ≥600vp 的宽屏线）。 */
export function currentBreakpoint(): string {
  let watched: string = themeState().breakpoint;
  let stored: string | undefined = AppStorage.get<string>('breakpoint');
  let bp: string = stored !== undefined && stored.length > 0 ? stored : watched;
  return bp === 'xl' ? 'xl' : bp === 'lg' ? 'lg' : bp === 'md' ? 'md' : 'sm';
}

/** md/lg/xl 走宽屏布局（顶部 Tab 栏 + 栅格多列卡片），维持 ≥600vp 语义不变。 */
export function isWideLayout(): boolean {
  return currentBreakpoint() !== 'sm';
}

/* ===== 首页栅格（GridRow/GridCol）统一断点体系：与 currentBreakpoint 的 600/840/1280vp 窗口宽三线对齐 ===== */

/**
 * 首页栅格统一断点（窗口宽）：xs <320vp / sm 320-600 / md 600-840 / lg 840-1280 / xl ≥1280。
 * 所有 GridRow 调用点（MetricsRow / WorkspaceTab / MirrorHomePage）必须共用，禁止各自漂移。
 */
export const HOME_GRID_BREAKPOINTS: BreakPoints = {
  value: ['320vp', '600vp', '840vp', '1280vp'],
  reference: BreakpointsReference.WindowSize
};

/** 栅格总列数：xs/sm 4 列、md 8 列、lg/xl 12 列（GridRow columns）。 */
export const HOME_GRID_COLUMNS: GridRowColumnOption = { xs: 4, sm: 4, md: 8, lg: 12, xl: 12 };

/** 栅格间距：列/行统一 12vp（卡片间与列间由此控制，卡内不再另加 margin）。 */
export const HOME_GRID_GUTTER: GutterOption = { x: 12, y: 12 };

/** 卡片 span（工作区卡与镜像会话卡同规则）：xs/sm 整行（4/4）、md 半宽（4/8）、lg 三列（4/12）、xl 四列（3/12，防超宽下单卡过宽）。 */
export const HOME_CARD_SPAN: GridColColumnOption = { xs: 4, sm: 4, md: 4, lg: 4, xl: 3 };

/** 指标块 span：xs/sm 两行两列（2/4）、md 单行四块（2/8）、lg/xl 单行四块（3/12）。 */
export const HOME_METRIC_SPAN: GridColColumnOption = { xs: 2, sm: 2, md: 2, lg: 3, xl: 3 };

/** 首页 GridRow 统一配置（columns/gutter/breakpoints 一处收敛，调用点直接 GridRow(HOME_GRID_OPTIONS)）。 */
export const HOME_GRID_OPTIONS: GridRowOptions = {
  columns: HOME_GRID_COLUMNS,
  gutter: HOME_GRID_GUTTER,
  breakpoints: HOME_GRID_BREAKPOINTS
};
