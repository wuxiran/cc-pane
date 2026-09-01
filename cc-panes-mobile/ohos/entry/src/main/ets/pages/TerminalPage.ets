import { AppNav } from '../common/Nav';
import { asRecord } from '../common/Json';
import { TERMINAL_BG } from '../common/Theme';
import { KeyBar } from '../components/KeyBar';
import { TerminalWebView } from '../components/TerminalWebView';
import { TerminalPhase, TerminalSessionController } from '../stores/TerminalController';

/**
 * 终端页为固定深底 UI（xterm #1E1E1E 底，对齐 PLAN/Flutter TerminalView），
 * 不随明暗主题切换；以下常量为深底专用色，Theme.ets 无对应色板（仅有
 * TERMINAL_BG 常量已复用），故保留本地定义而不取 currentTheme()。
 */
/** 主色 teal（对齐 Flutter colorScheme.primary 种子 #009688）。 */
const PRIMARY: string = '#009688';
const TITLE_FG: string = '#EAEAEA';
const SHIMMER_TRACK_BG: string = '#2A2A2A';
const BANNER_BG: string = '#3B2C2C';
const BANNER_FG: string = '#F2B8B5';
const BANNER_ACTION_FG: string = '#80CBC4';
/** 顶栏「适配尺寸」按钮文案（sys.symbol 无确定等价物；⤢ 在部分字体缺字形，用中文字避免豆腐块）。 */
const FIT_ICON: string = '适';
const FIT_TOOLTIP: string = '把 PTY 尺寸调整为手机屏幕（会影响桌面端同一会话的渲染）';
const FIT_TOAST: string = '已按手机屏幕调整终端尺寸';
/** 宽屏断点（vp）：≥ 此宽度时 KeyBar 居中限宽。 */
const WIDE_BREAKPOINT_VP: number = 600;
const KEYBAR_MAX_WIDTH_VP: number = 720;
/** 连接中横幅的去背色带（2vp，来回扫动的浅色短条）。 */
const SHIMMER_BAR_WIDTH: number = 96;
const SHIMMER_X_START: number = -120;
const SHIMMER_X_END: number = 400;
const SHIMMER_INTERVAL_MS: number = 750;
const SHIMMER_DURATION_MS: number = 700;

/**
 * 终端页（NavDestination，由 Index 的 Navigation 路由到，name = AppNav.ROUTE_TERMINAL，
 * param = { sessionId: string, title: string }）：
 * xterm WebView + 状态横幅（connecting/error/exited）+ KeyBar 快捷键条。
 * 默认不 resize 共享 PTY（避免破坏桌面端渲染），顶栏提供手动「适配尺寸」；
 * 手动适配过后，旋转/键盘等尺寸变化会经 controller.requestResize 自动跟随（300ms 去抖）。
 * 生命周期：onReady 解析参数并建 controller + start；aboutToDisappear dispose；
 * 「重连」= dispose 旧实例 → new 新实例再 start（语义对齐 Flutter ref.invalidate）。
 */
@ComponentV2
export struct TerminalPage {
  /** 会话标题（路由参数填充，缺失时兜底「终端」）。 */
  @Local title: string = '';
  @Local controller: TerminalSessionController | undefined = undefined;
  /** 宽屏（≥600vp）标记：KeyBar 居中限宽 720vp。 */
  @Local isWide: boolean = false;
  /** 连接中横幅扫描条的当前偏移（vp，animateTo 驱动）。 */
  @Local shimmerX: number = SHIMMER_X_START;

  private sessionId: string = '';
  private started: boolean = false;
  /** 页面侧缓存的当前终端几何（JS fit 后上报，供「适配尺寸」按钮取值）。 */
  private geomCols: number = 0;
  private geomRows: number = 0;
  private shimmerTimer: number = -1;
  private shimmerForward: boolean = false;
  private handleGeometry: (cols: number, rows: number) => void = (cols: number, rows: number): void => {
    this.geomCols = cols;
    this.geomRows = rows;
  };

  aboutToDisappear(): void {
    this.stopShimmer();
    let controller: TerminalSessionController | undefined = this.controller;
    if (controller !== undefined) {
      controller.dispose();
    }
  }

  build() {
    NavDestination() {
      Column() {
        if (this.controller !== undefined) {
          if (this.controller.phase === TerminalPhase.Connecting) {
            this.connectingBar()
          } else if (this.controller.phase === TerminalPhase.Error) {
            this.statusBanner(
              this.controller.errorMessage !== undefined && this.controller.errorMessage.length > 0
                ? this.controller.errorMessage
                : '连接中断',
              '重连',
              (): void => {
                this.reconnect();
              })
          } else if (this.controller.phase === TerminalPhase.Exited) {
            this.statusBanner(
              `会话已退出（exit ${this.controller.exitCode !== undefined ? this.controller.exitCode : '?'}）`,
              '返回',
              (): void => {
                AppNav.stack.pop();
              })
          }
          TerminalWebView({ controller: this.controller, onGeometryChange: this.handleGeometry })
            .layoutWeight(1)
            .width('100%')
          if (this.isWide) {
            Row() {
              Column() {
                KeyBar({ controller: this.controller })
              }
              .constraintSize({ maxWidth: KEYBAR_MAX_WIDTH_VP })
              .width('100%')
            }
            .width('100%')
            .justifyContent(FlexAlign.Center)
          } else {
            KeyBar({ controller: this.controller })
          }
        }
      }
      .width('100%')
      .height('100%')
      .onSizeChange((oldValue: SizeResult, newValue: SizeResult): void => {
        this.isWide = newValue.width >= WIDE_BREAKPOINT_VP;
      })
    }
    .title(this.navTitle)
    .menus(this.navMenus)
    .backgroundColor(TERMINAL_BG)
    .onReady((context: NavDestinationContext): void => {
      this.initFromContext(context);
    })
    .onShown((): void => {
      this.ensureStarted();
    })
  }

  /** NavDestination 标题：单行省略的路由标题。 */
  @Builder
  navTitle() {
    Text(this.title.length > 0 ? this.title : '终端')
      .fontSize(18)
      .fontWeight(FontWeight.Medium)
      .fontColor(TITLE_FG)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .constraintSize({ maxWidth: '100%' })
  }

  /** NavDestination 右侧菜单：phase==connected 时显示「适配尺寸」；长按看说明（对齐 Flutter tooltip）。 */
  @Builder
  navMenus() {
    if (this.controller !== undefined && this.controller.phase === TerminalPhase.Connected) {
      Text(FIT_ICON)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor(TITLE_FG)
        .width(40)
        .height(40)
        .textAlign(TextAlign.Center)
        .onClick((): void => {
          this.onFitPressed();
        })
        .gesture(
          LongPressGesture()
            .onAction((event: GestureEvent): void => {
              this.showToast(FIT_TOOLTIP);
            })
        )
    }
  }

  /** connecting → 2vp 线性进度横幅（定时器驱动的来回扫描条，phase 离开 connecting 自停）。 */
  @Builder
  connectingBar() {
    Row() {
      Row()
        .width(SHIMMER_BAR_WIDTH)
        .height(2)
        .borderRadius(1)
        .backgroundColor(PRIMARY)
        .translate({ x: this.shimmerX })
    }
    .width('100%')
    .height(2)
    .backgroundColor(SHIMMER_TRACK_BG)
    .clip(true)
    .onAppear((): void => {
      this.startShimmer();
    })
  }

  /** error/exited 状态横幅：消息 + 单个动作按钮（对齐 Flutter MaterialBanner）。 */
  @Builder
  statusBanner(message: string, actionLabel: string, action: () => void) {
    Row() {
      Text(message)
        .fontSize(13)
        .fontColor(BANNER_FG)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Text(actionLabel)
        .fontSize(14)
        .fontColor(BANNER_ACTION_FG)
        .padding({ left: 12, right: 12, top: 6, bottom: 6 })
        .onClick((): void => {
          action();
        })
    }
    .width('100%')
    .padding({ left: 12, right: 4, top: 6, bottom: 6 })
    .backgroundColor(BANNER_BG)
    .alignItems(VerticalAlign.Center)
  }

  /** 解析路由参数 { sessionId, title } 并启动会话（onReady 时调用，仅一次生效）。 */
  private initFromContext(context: NavDestinationContext): void {
    let rec: Record<string, Object> | undefined = asRecord(context.pathInfo.param as Object | undefined);
    if (rec !== undefined) {
      let sessionId: Object | undefined = rec['sessionId'];
      if (typeof sessionId === 'string') {
        this.sessionId = sessionId as string;
      }
      let title: Object | undefined = rec['title'];
      if (typeof title === 'string') {
        this.title = title as string;
      }
    }
    this.ensureStarted();
  }

  /** 建 controller 并 start（onReady/onShown 双入口幂等；start 本身也有 starting 防抖）。 */
  private ensureStarted(): void {
    if (this.sessionId.length === 0) {
      return;
    }
    if (this.controller === undefined) {
      this.controller = new TerminalSessionController(this.sessionId);
    }
    if (!this.started) {
      this.started = true;
      this.controller.start();
    }
  }

  /** 销毁重建 controller（语义=Flutter ref.invalidate）；新实例由 TerminalWebView 的 @Monitor 重新挂桥。 */
  private reconnect(): void {
    let old: TerminalSessionController | undefined = this.controller;
    if (old !== undefined) {
      old.clearTerminal();
      old.dispose();
    }
    if (this.sessionId.length === 0) {
      this.controller = undefined;
      return;
    }
    let fresh: TerminalSessionController = new TerminalSessionController(this.sessionId);
    this.controller = fresh;
    this.started = true;
    fresh.start();
  }

  /** 「适配尺寸」：markUserFitted + 按当前几何立即 resize（对齐 Flutter resizeToView）。 */
  private onFitPressed(): void {
    let controller: TerminalSessionController | undefined = this.controller;
    if (controller === undefined) {
      return;
    }
    controller.markUserFitted();
    if (this.geomCols > 0 && this.geomRows > 0) {
      controller.fitNow(this.geomCols, this.geomRows);
    }
    this.showToast(FIT_TOAST);
  }

  private startShimmer(): void {
    this.stopShimmer();
    this.shimmerTimer = setInterval((): void => {
      let connecting: boolean =
        this.controller !== undefined && this.controller.phase === TerminalPhase.Connecting;
      if (!connecting) {
        this.stopShimmer();
        return;
      }
      this.shimmerForward = !this.shimmerForward;
      this.getUIContext().animateTo(
        { duration: SHIMMER_DURATION_MS, curve: Curve.EaseInOut },
        (): void => {
          this.shimmerX = this.shimmerForward ? SHIMMER_X_END : SHIMMER_X_START;
        }
      );
    }, SHIMMER_INTERVAL_MS);
  }

  private stopShimmer(): void {
    if (this.shimmerTimer >= 0) {
      clearInterval(this.shimmerTimer);
      this.shimmerTimer = -1;
    }
  }

  private showToast(message: string): void {
    this.getUIContext().getPromptAction().showToast({ message: message, duration: 2500 });
  }
}
