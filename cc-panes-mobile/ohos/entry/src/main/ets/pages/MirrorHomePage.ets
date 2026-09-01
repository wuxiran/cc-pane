import { mediaquery } from '@kit.ArkUI';
import { AppConfig } from '../common/Config';
import { relativeTime } from '../common/Format';
import {
  applyBreakpoint,
  currentTheme,
  HOME_CARD_SPAN,
  HOME_GRID_OPTIONS,
  isWideLayout
} from '../common/Theme';
import { MirrorCard, MirrorGroup } from '../model/MirrorState';
import { GroupHeader } from '../components/GroupHeader';
import { MirrorCardTile } from '../components/MirrorCard';
import { authController } from '../stores/AuthController';
import { launchHistoryStore } from '../stores/LaunchHistoryStore';
import { mirrorController } from '../stores/MirrorController';
import { workspacesController } from '../stores/WorkspacesController';
import { WorkspaceTab } from './WorkspaceTab';

/**
 * 双 Tab 首页（对齐 Flutter mirror_home_screen）：
 * Tab0 工作区（WorkspaceTab）/ Tab1 终端镜像。
 * 顶栏：Tab0 固定『CC-Panes』；Tab1 = 快照工作区名 + 『同步于 X 前』；
 * 陈旧/只读 Chip + 手动刷新（mirror + workspaces + launchHistory，36vp 圆角 IconButton）。
 * UI 栅格自适应：GridRow 4/8/12 列、xl 12 列（统一走 Theme.HOME_GRID_OPTIONS，窗口宽断点
 * 320/600/840/1280vp，与 currentBreakpoint 对齐）——xs/sm 底部 Tab 栏 + 卡片整行；
 * md/lg Tab 栏移顶部（单行胶囊样式）+ 卡片半宽/三列；xl 四列（防超宽下单卡过宽）。
 * 镜像分组头独立于 GridRow 成行（跨满内容宽），组内会话卡与工作区卡同 span，两 Tab 观感统一。
 * 矮屏（高度 <400vp，如手机横屏）：顶栏收薄并隐藏副标题，顶栏/Tab 栏外的内容区一律
 * layoutWeight + 可滚，不叠固定高度。
 * 轮询生命周期：进入页面启动 5s 轮询；Navigation push 进终端页不停轮询（组件未销毁，
 * aboutToDisappear 不触发），真实停点只有组件销毁；auth 离开 Ready 时 refresh 空转（等效停摆）。
 * 另有 30s UI tick（SNAPSHOT_UI_TICK_MS）重算『同步于 X 前』与 stale，避免轮询停摆时相对时间冻结。
 */
@ComponentV2
export struct MirrorHomePage {
  @Local tab: number = 0;
  @Local mirrorLoading: boolean = true;
  @Local refreshing: boolean = false;
  @Local mirrorPulling: number = 0;
  @Local mirrorAtStart: boolean = true;
  /** 矮屏（窗口高 <400vp，如手机横屏）：顶栏收薄、副标题隐藏。 */
  @Local compactHeight: boolean = false;
  /** 30s tick 的当前时刻（重算相对时间与 stale 的基准，不触发网络请求）。 */
  @Local clockTick: number = Date.now();
  private staleTickTimer: number = -1;
  private mdListener: mediaquery.MediaQueryListener | undefined = undefined;
  private lgListener: mediaquery.MediaQueryListener | undefined = undefined;
  private xlListener: mediaquery.MediaQueryListener | undefined = undefined;
  private shortHeightListener: mediaquery.MediaQueryListener | undefined = undefined;
  private mirrorScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    this.setupBreakpoints();
    this.kickOff();
    this.staleTickTimer = setInterval((): void => {
      this.clockTick = Date.now();
    }, AppConfig.SNAPSHOT_UI_TICK_MS);
  }

  aboutToDisappear(): void {
    this.teardownBreakpoints();
    mirrorController().stop();
    if (this.staleTickTimer >= 0) {
      clearInterval(this.staleTickTimer);
      this.staleTickTimer = -1;
    }
  }

  setupBreakpoints(): void {
    let mediaQuery = this.getUIContext().getMediaQuery();
    this.mdListener = mediaQuery.matchMediaSync('(min-width: 600vp)');
    this.mdListener.on('change', (): void => {
      this.syncBreakpoint();
    });
    this.lgListener = mediaQuery.matchMediaSync('(min-width: 840vp)');
    this.lgListener.on('change', (): void => {
      this.syncBreakpoint();
    });
    this.xlListener = mediaQuery.matchMediaSync('(min-width: 1280vp)');
    this.xlListener.on('change', (): void => {
      this.syncBreakpoint();
    });
    this.shortHeightListener = mediaQuery.matchMediaSync('(max-height: 400vp)');
    this.shortHeightListener.on('change', (): void => {
      this.syncBreakpoint();
    });
    this.syncBreakpoint();
  }

  syncBreakpoint(): void {
    let extraLarge: boolean = this.xlListener !== undefined && this.xlListener.matches;
    let large: boolean = this.lgListener !== undefined && this.lgListener.matches;
    let medium: boolean = this.mdListener !== undefined && this.mdListener.matches;
    applyBreakpoint(extraLarge ? 'xl' : large ? 'lg' : medium ? 'md' : 'sm');
    this.compactHeight = this.shortHeightListener !== undefined && this.shortHeightListener.matches;
  }

  teardownBreakpoints(): void {
    if (this.mdListener !== undefined) {
      this.mdListener.off('change');
      this.mdListener = undefined;
    }
    if (this.lgListener !== undefined) {
      this.lgListener.off('change');
      this.lgListener = undefined;
    }
    if (this.xlListener !== undefined) {
      this.xlListener.off('change');
      this.xlListener = undefined;
    }
    if (this.shortHeightListener !== undefined) {
      this.shortHeightListener.off('change');
      this.shortHeightListener = undefined;
    }
  }

  /** 首次进入：完整等待一次镜像拉取（loading 收敛）→ 启动 5s 轮询 → 拉工作区与历史。 */
  async kickOff(): Promise<void> {
    let mirror = mirrorController();
    await mirror.refresh();
    this.mirrorLoading = false;
    mirror.start();
    workspacesController().refresh().catch((): void => {
    });
    launchHistoryStore().refresh().catch((): void => {
    });
  }

  async manualRefresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    await mirrorController().refresh();
    await workspacesController().refresh();
    await launchHistoryStore().refresh();
    this.refreshing = false;
  }

  sessionCount(): number {
    let count: number = 0;
    for (let group of mirrorController().state.groups) {
      count += group.cards.length;
    }
    return count;
  }

  mirrorTitle(): string {
    let name: string | undefined = mirrorController().state.workspaceName;
    if (name !== undefined && name.length > 0) {
      return name;
    }
    let profile = authController().profile;
    return profile !== undefined ? profile.name : '';
  }

  syncSubtitle(): string {
    let savedAt: number | undefined = mirrorController().state.savedAtMs;
    if (savedAt === undefined) {
      return '电脑镜像';
    }
    return `同步于 ${relativeTime(savedAt, this.clockTick)}`;
  }

  /** 30s tick 重算的 stale（轮询停摆时 state.stale 冻结，这里按 savedAt 现算）。 */
  isStateStale(): boolean {
    let savedAt: number | undefined = mirrorController().state.savedAtMs;
    return savedAt !== undefined && (this.clockTick - savedAt) > AppConfig.SNAPSHOT_STALE_MS;
  }

  errorMessage(): string {
    let failure = mirrorController().error;
    return failure !== undefined ? failure.message : '';
  }

  @Builder
  chip(text: string, bg: string, fg: string) {
    Text(text)
      .fontSize(10)
      .fontColor(fg)
      .padding({ left: 8, right: 8, top: 3, bottom: 3 })
      .backgroundColor(bg)
      .borderRadius(999)
      .maxLines(1)
  }

  @Builder
  headerBar() {
    Row({ space: 8 }) {
      Column({ space: 1 }) {
        Text(this.tab === 1 ? this.mirrorTitle() : 'CC-Panes')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.tab === 1 && !this.compactHeight) {
          Text(this.syncSubtitle())
            .fontSize(11)
            .fontColor(currentTheme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.tab === 1 && this.isStateStale()) {
        this.chip('数据陈旧', currentTheme().staleDim, currentTheme().staleText)
      }
      if (authController().readOnly()) {
        this.chip('只读', currentTheme().errorDim, currentTheme().error)
      }
      if (this.refreshing) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color(currentTheme().primary)
      } else {
        Text('↻')
          .fontSize(17)
          .fontColor(currentTheme().textSecondary)
          .width(36)
          .height(36)
          .textAlign(TextAlign.Center)
          .borderRadius(10)
          .backgroundColor(currentTheme().badgeBg)
          .clickEffect({ level: ClickEffectLevel.LIGHT, scale: 0.9 })
          .onClick(() => {
            this.manualRefresh();
          })
      }
    }
    .width('100%')
    .constraintSize({ minHeight: this.compactHeight ? 44 : 52 })
    .padding({ left: 16, right: 12, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
  }

  /** sm 底部 Tab 项：图标在上、文字在下。 */
  @Builder
  bottomTabItem(label: string, glyph: string, index: number, badge: number) {
    Column({ space: 3 }) {
      Stack({ alignContent: Alignment.TopEnd }) {
        Text(glyph)
          .fontSize(20)
          .fontWeight(this.tab === index ? FontWeight.Bold : FontWeight.Normal)
          .fontColor(this.tab === index ? currentTheme().primary : currentTheme().textSecondary)
          .height(24)
        if (badge > 0) {
          Text(`${badge}`)
            .fontSize(9)
            .fontColor(currentTheme().onPrimary)
            .backgroundColor(currentTheme().primary)
            .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            .borderRadius(8)
            .constraintSize({ minWidth: 14 })
            .textAlign(TextAlign.Center)
            .offset({ x: 6, y: -4 })
        }
      }
      .height(26)
      Text(label)
        .fontSize(11)
        .fontColor(this.tab === index ? currentTheme().primary : currentTheme().textSecondary)
    }
    .justifyContent(FlexAlign.Center)
    .padding({ top: 6, bottom: 6 })
  }

  /** md/lg 顶部 Tab 项：单行胶囊（选中 teal 底、徽标内联），不占两行。 */
  @Builder
  topTabPill(label: string, glyph: string, index: number, badge: number) {
    Row({ space: 6 }) {
      Text(glyph)
        .fontSize(14)
        .fontWeight(this.tab === index ? FontWeight.Bold : FontWeight.Normal)
        .fontColor(this.tab === index ? currentTheme().primary : currentTheme().textSecondary)
      Text(label)
        .fontSize(14)
        .fontWeight(this.tab === index ? FontWeight.Bold : FontWeight.Normal)
        .fontColor(this.tab === index ? currentTheme().primary : currentTheme().textSecondary)
      if (badge > 0) {
        Text(`${badge}`)
          .fontSize(10)
          .fontColor(currentTheme().onPrimary)
          .backgroundColor(currentTheme().primary)
          .padding({ left: 5, right: 5, top: 1, bottom: 1 })
          .borderRadius(999)
          .constraintSize({ minWidth: 16 })
          .textAlign(TextAlign.Center)
      }
    }
    .padding({ left: 14, right: 14, top: 8, bottom: 8 })
    .borderRadius(999)
    .backgroundColor(this.tab === index ? currentTheme().primaryDim : Color.Transparent)
  }

  @Builder
  tabBar(label: string, glyph: string, index: number, badge: number) {
    if (isWideLayout()) {
      this.topTabPill(label, glyph, index, badge)
    } else {
      this.bottomTabItem(label, glyph, index, badge)
    }
  }

  @Builder
  pullIndicator() {
    Row() {
      Text(this.mirrorPulling >= 60 ? '释放刷新' : '下拉刷新')
        .fontSize(11)
        .fontColor(currentTheme().textSecondary)
    }
    .width('100%')
    .height(this.mirrorPulling)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  mirrorStateView() {
    if (this.mirrorLoading) {
      Column() {
        LoadingProgress()
          .width(28)
          .height(28)
          .color(currentTheme().primary)
      }
      .justifyContent(FlexAlign.Center)
      .layoutWeight(1)
      .width('100%')
    } else if (mirrorController().error !== undefined && mirrorController().state.groups.length === 0) {
      Column({ space: 10 }) {
        Text('加载失败')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().textPrimary)
        Text(this.errorMessage())
          .fontSize(12)
          .fontColor(currentTheme().textSecondary)
          .maxLines(2)
          .textAlign(TextAlign.Center)
        Button('重试')
          .height(36)
          .padding({ left: 24, right: 24 })
          .fontSize(14)
          .backgroundColor(currentTheme().primary)
          .fontColor(currentTheme().onPrimary)
          .borderRadius(10)
          .onClick(() => {
            this.mirrorLoading = true;
            mirrorController().refresh().then((): void => {
              this.mirrorLoading = false;
            });
          })
      }
      .justifyContent(FlexAlign.Center)
      .layoutWeight(1)
      .width('100%')
    } else if (mirrorController().state.isEmpty) {
      Column({ space: 8 }) {
        Text('🖥')
          .fontSize(40)
          .fontColor(currentTheme().textSecondary)
        Text(mirrorController().state.snapshotAvailable
          ? '电脑当前没有在跑的会话'
          : '电脑未运行或未打开 CC-Panes 前端')
          .fontSize(14)
          .fontColor(currentTheme().textPrimary)
        Text('在工作区里选一个项目，点按即可启动终端')
          .fontSize(12)
          .fontColor(currentTheme().textSecondary)
      }
      .justifyContent(FlexAlign.Center)
      .layoutWeight(1)
      .width('100%')
      .parallelGesture(
        PanGesture({ fingers: 1, direction: PanDirection.Vertical, distance: 8 })
          .onActionUpdate((event: GestureEvent) => {
            this.mirrorPulling = Math.max(0, Math.min(84, event.offsetY));
          })
          .onActionEnd(() => {
            if (this.mirrorPulling >= 60) {
              this.manualRefresh();
            }
            this.mirrorPulling = 0;
          })
      )
    } else {
      this.mirrorGrid()
    }
  }

  /** 镜像列表：组头独立成行（跨满内容宽）+ 组内会话卡 GridRow 栅格（span 与工作区卡一致）。 */
  @Builder
  mirrorGrid() {
    Scroll(this.mirrorScroller) {
      Column() {
        ForEach(mirrorController().state.groups, (group: MirrorGroup) => {
          GroupHeader({ group: group })
            .width('100%')
            .margin({ bottom: 8 })
          GridRow(HOME_GRID_OPTIONS) {
            ForEach(group.cards, (card: MirrorCard) => {
              GridCol({ span: HOME_CARD_SPAN }) {
                MirrorCardTile({ card: card })
              }
            }, (card: MirrorCard) => card.sessionId)
          }
          .width('100%')
          .margin({ bottom: 4 })
        }, (group: MirrorGroup) => `${group.kind}|${group.layoutId !== undefined ? group.layoutId : group.title}`)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 4, bottom: 16 })
    }
    .width('100%')
    .layoutWeight(1)
    .edgeEffect(EdgeEffect.None)
    .onDidScroll((scrollOffset: number, scrollState: ScrollState) => {
      this.mirrorAtStart = this.mirrorScroller.currentOffset().yOffset <= 1;
    })
    .parallelGesture(
      PanGesture({ fingers: 1, direction: PanDirection.Vertical, distance: 8 })
        .onActionUpdate((event: GestureEvent) => {
          if (this.mirrorAtStart && !this.refreshing) {
            this.mirrorPulling = Math.max(0, Math.min(84, event.offsetY));
          }
        })
        .onActionEnd(() => {
          if (this.mirrorPulling >= 60) {
            this.manualRefresh();
          }
          this.mirrorPulling = 0;
        })
    )
  }

  build() {
    Column() {
      this.headerBar()
      Tabs({
        barPosition: isWideLayout() ? BarPosition.Start : BarPosition.End,
        index: this.tab
      }) {
        TabContent() {
          WorkspaceTab()
        }
        .tabBar(this.tabBar('工作区', '▦', 0, 0))

        TabContent() {
          Column() {
            this.pullIndicator()
            this.mirrorStateView()
          }
          .width('100%')
          .height('100%')
        }
        .tabBar(this.tabBar('终端', '>_', 1, this.sessionCount()))
      }
      .onChange((index: number) => {
        this.tab = index;
      })
      .vertical(false)
      .barHeight(isWideLayout() ? 48 : 56)
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(currentTheme().background)
  }
}
