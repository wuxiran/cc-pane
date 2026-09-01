import { currentTheme, HOME_CARD_SPAN, HOME_GRID_OPTIONS } from '../common/Theme';
import { Workspace } from '../model/Workspace';
import { MetricsRow } from '../components/MetricsRow';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { launchHistoryStore } from '../stores/LaunchHistoryStore';
import { mirrorController } from '../stores/MirrorController';
import { workspacesController } from '../stores/WorkspacesController';

/**
 * 工作区 Tab（对齐 Flutter workspace_tab.WorkspaceTab）：
 * 指标条 → 工作区卡（内嵌项目行）；loading / 加载失败+重试 / 空列表三态；
 * 下拉刷新（自实现 PanGesture + LoadingProgress）。
 * 栅格：GridRow 统一走 Theme.HOME_GRID_OPTIONS（窗口宽断点 320/600/840/1280vp，与
 * currentBreakpoint 对齐）——指标条整行（自身按 2/2/3/3 span 排布），
 * 工作区卡 xs/sm 整行 / md 半宽 / lg 三列 / xl 四列。
 */
@ComponentV2
export struct WorkspaceTab {
  @Local refreshing: boolean = false;
  @Local pulling: number = 0;
  @Local atStart: boolean = true;
  private scroller: Scroller = new Scroller();

  aboutToAppear(): void {
    let controller = workspacesController();
    if (!controller.loaded) {
      controller.refresh().catch((): void => {
      });
    }
  }

  async doRefresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    await workspacesController().refresh();
    await launchHistoryStore().refresh();
    await mirrorController().refresh();
    this.refreshing = false;
  }

  @Builder
  pullIndicator() {
    Row() {
      if (this.refreshing) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color(currentTheme().primary)
      } else if (this.pulling > 0) {
        Text(this.pulling >= 60 ? '释放刷新' : '下拉刷新')
          .fontSize(11)
          .fontColor(currentTheme().textSecondary)
      }
    }
    .width('100%')
    .height(this.refreshing ? 32 : this.pulling)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  stateView() {
    Column({ space: 10 }) {
      if (!workspacesController().loaded && workspacesController().failure === undefined) {
        LoadingProgress()
          .width(28)
          .height(28)
          .color(currentTheme().primary)
      } else {
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
            workspacesController().refresh().catch((): void => {
            });
          })
      }
    }
    .justifyContent(FlexAlign.Center)
    .layoutWeight(1)
    .width('100%')
  }

  errorMessage(): string {
    let failure = workspacesController().failure;
    return failure !== undefined ? failure.message : '';
  }

  @Builder
  contentGrid() {
    Scroll(this.scroller) {
      Column() {
        MetricsRow({ workspaces: workspacesController().workspaces })
          .width('100%')
          .margin({ bottom: 12 })

        if (workspacesController().workspaces.length === 0) {
          Text('桌面端还没有工作空间')
            .fontSize(14)
            .fontColor(currentTheme().textSecondary)
            .padding(40)
        } else {
          GridRow(HOME_GRID_OPTIONS) {
            ForEach(workspacesController().workspaces, (workspace: Workspace) => {
              GridCol({ span: HOME_CARD_SPAN }) {
                WorkspaceCard({ workspace: workspace })
              }
            }, (workspace: Workspace, index: number) => workspace.id.length > 0 ? workspace.id : `${index}`)
          }
          .width('100%')
        }
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 16 })
    }
    .width('100%')
    .layoutWeight(1)
    .edgeEffect(EdgeEffect.None)
    .onDidScroll((scrollOffset: number, scrollState: ScrollState) => {
      this.atStart = this.scroller.currentOffset().yOffset <= 1;
    })
    .parallelGesture(
      PanGesture({ fingers: 1, direction: PanDirection.Vertical, distance: 8 })
        .onActionUpdate((event: GestureEvent) => {
          if (this.atStart && !this.refreshing) {
            this.pulling = Math.max(0, Math.min(84, event.offsetY));
          }
        })
        .onActionEnd(() => {
          if (this.pulling >= 60) {
            this.doRefresh();
          }
          this.pulling = 0;
        })
    )
  }

  build() {
    Column() {
      this.pullIndicator()
      if (!workspacesController().loaded && workspacesController().failure === undefined) {
        this.stateView()
      } else if (workspacesController().failure !== undefined && workspacesController().workspaces.length === 0) {
        this.stateView()
      } else {
        this.contentGrid()
      }
    }
    .width('100%')
    .height('100%')
  }
}
