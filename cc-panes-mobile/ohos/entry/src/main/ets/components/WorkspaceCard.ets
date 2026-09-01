import { currentTheme } from '../common/Theme';
import { Workspace, WorkspaceProject } from '../model/Workspace';
import { LaunchSheet } from './LaunchSheet';
import { ProjectRow } from './ProjectRow';
import { WorkspaceActionsSheet } from './WorkspaceActionsSheet';

const EMPTY_WORKSPACE: Workspace = new Workspace('', '', undefined, undefined, false, false, []);

/** 工作区 path 中间省略阈值（lg 三列下卡内宽度有限，超长目录保留头尾）。 */
const WORKSPACE_PATH_LIMIT: number = 32;
const WORKSPACE_PATH_HEAD: number = 12;
const WORKSPACE_PATH_TAIL: number = 16;

function middleEllipsizePath(path: string): string {
  if (path.length <= WORKSPACE_PATH_LIMIT) {
    return path;
  }
  return `${path.substring(0, WORKSPACE_PATH_HEAD)}…${path.substring(path.length - WORKSPACE_PATH_TAIL)}`;
}

/**
 * 工作区卡片（对齐 Flutter workspace_tab._WorkspaceCard）：
 * 40vp 圆角图标块（displayName 首字符，teal 底色）+ 名称（15fp/600）
 * + path（12fp 次要、中间省略）+ pills 行（已置顶/已隐藏/N 个项目，11fp 圆角全弧）
 * + ⋯ 操作按钮右上；内嵌项目行列表（行间分隔线、按压态）；空项目显示『暂无项目』。
 * 卡片本体：card 底、圆角 14、padding 14、1vp divider 描边（深浅两模式均干净）；
 * 卡片间/列间 12vp 由外层 GridRow gutter 统一控制。
 */
@ComponentV2
export struct WorkspaceCard {
  @Param workspace: Workspace = EMPTY_WORKSPACE;
  @Local showSheet: boolean = false;
  /** 弹层内容：'actions' 工作区操作 / 'launch' 项目启动。 */
  @Local sheetView: string = 'actions';
  @Local launchTarget: WorkspaceProject | undefined = undefined;
  @Local menuPressed: boolean = false;

  iconGlyph(): string {
    let name: string = this.workspace.displayName;
    return name.length > 0 ? name.substring(0, 1) : '·';
  }

  hasPath(): boolean {
    return this.workspace.path !== undefined && this.workspace.path.length > 0;
  }

  workspacePath(): string {
    let path: string = this.workspace.path !== undefined ? this.workspace.path : '';
    return middleEllipsizePath(path);
  }

  @Builder
  pill(label: string) {
    Text(label)
      .fontSize(11)
      .fontColor(currentTheme().textSecondary)
      .padding({ left: 8, right: 8, top: 2, bottom: 2 })
      .margin({ right: 6 })
      .backgroundColor(currentTheme().badgeBg)
      .borderRadius(999)
      .maxLines(1)
  }

  @Builder
  pills() {
    Flex({ wrap: FlexWrap.Wrap }) {
      if (this.workspace.pinned) {
        this.pill('已置顶')
      }
      if (this.workspace.hidden) {
        this.pill('已隐藏')
      }
      this.pill(`${this.workspace.projectCount} 个项目`)
    }
    .margin({ top: 4 })
  }

  @Builder
  menuButton() {
    Text('···')
      .fontSize(18)
      .fontColor(currentTheme().textSecondary)
      .width(36)
      .height(36)
      .textAlign(TextAlign.Center)
      .borderRadius(10)
      .backgroundColor(this.menuPressed ? currentTheme().badgeBg : Color.Transparent)
      .onTouch((event: TouchEvent) => {
        if (event.type === TouchType.Down) {
          this.menuPressed = true;
        } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
          this.menuPressed = false;
        }
      })
      .onClick(() => {
        this.launchTarget = undefined;
        this.sheetView = 'actions';
        this.showSheet = true;
      })
  }

  @Builder
  sheetContent() {
    if (this.sheetView === 'launch' && this.launchTarget !== undefined) {
      LaunchSheet({
        project: this.launchTarget,
        workspaceName: this.workspace.name,
        onClose: (): void => {
          this.showSheet = false;
          this.sheetView = 'actions';
        }
      })
    } else {
      WorkspaceActionsSheet({
        workspace: this.workspace,
        onClose: (): void => {
          this.showSheet = false;
        },
        onOpenTerminal: (project: WorkspaceProject): void => {
          this.launchTarget = project;
          this.sheetView = 'launch';
        }
      })
    }
  }

  @Builder
  projectList() {
    if (this.workspace.projects.length === 0) {
      Text('暂无项目')
        .fontSize(12)
        .fontColor(currentTheme().textSecondary)
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: 14, bottom: 14 })
        .margin({ top: 6 })
    } else {
      Column() {
        ForEach(this.workspace.projects, (project: WorkspaceProject, index: number) => {
          ProjectRow({
            project: project,
            workspaceName: this.workspace.name,
            showDivider: index > 0
          })
        }, (project: WorkspaceProject, index: number) => `${this.workspace.id}|${project.id}|${index}`)
      }
      .width('100%')
      .margin({ top: 6 })
    }
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        Text(this.iconGlyph())
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().primary)
          .width(40)
          .height(40)
          .textAlign(TextAlign.Center)
          .borderRadius(12)
          .backgroundColor(currentTheme().primaryDim)
        Column({ space: 2 }) {
          Text(this.workspace.displayName)
            .fontSize(15)
            .fontWeight(600)
            .fontColor(currentTheme().textPrimary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.hasPath()) {
            Text(this.workspacePath())
              .fontSize(12)
              .fontColor(currentTheme().textSecondary)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          this.pills()
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        this.menuButton()
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      this.projectList()
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(14)
    .borderRadius(14)
    .backgroundColor(currentTheme().card)
    .border({ width: 1, color: currentTheme().divider })
    .bindSheet(this.showSheet, this.sheetContent(), {
      height: SheetSize.FIT_CONTENT,
      dragBar: true,
      showClose: false,
      onDisappear: (): void => {
        this.showSheet = false;
        this.sheetView = 'actions';
      }
    })
  }
}
