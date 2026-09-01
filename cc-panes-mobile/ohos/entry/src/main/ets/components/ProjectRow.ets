import { currentTheme } from '../common/Theme';
import { normalizeProjectPath } from '../model/LayoutSnapshot';
import { WorkspaceProject } from '../model/Workspace';
import { mirrorController } from '../stores/MirrorController';
import { LaunchSheet } from './LaunchSheet';

const EMPTY_PROJECT: WorkspaceProject = new WorkspaceProject('', '', undefined);

/** 项目 path 中间省略阈值：超出保留头尾（尾部省略会把文件名吞掉）。 */
const PROJECT_PATH_LIMIT: number = 26;
const PROJECT_PATH_HEAD: number = 8;
const PROJECT_PATH_TAIL: number = 14;

function middleEllipsizePath(path: string): string {
  if (path.length <= PROJECT_PATH_LIMIT) {
    return path;
  }
  return `${path.substring(0, PROJECT_PATH_HEAD)}…${path.substring(path.length - PROJECT_PATH_TAIL)}`;
}

/**
 * 项目行（对齐 Flutter workspace_tab._ProjectRow）：
 * 18vp 图标 + 项目名（14fp/500）+ path（11fp 次要、中间省略）
 * + 『电脑在跑』『手机打开』徽标 + chevron；行高 ≥48、行间 1vp 分隔线（首行无）、按压态背景微变；
 * 点按弹出 LaunchSheet。徽标数据唯一来源 mirrorController().state（desktopProjectPaths / mobileProjectPaths）。
 */
@ComponentV2
export struct ProjectRow {
  @Param project: WorkspaceProject = EMPTY_PROJECT;
  @Param workspaceName: string = '';
  /** 行间分隔线：由父组件按『非首行』传入（最后一行自然无下边线）。 */
  @Param showDivider: boolean = false;
  @Local showSheet: boolean = false;
  @Local pressed: boolean = false;

  desktopRunning(): boolean {
    let state = mirrorController().state;
    return state.desktopProjectPaths.has(normalizeProjectPath(this.project.path));
  }

  mobileOpen(): boolean {
    let state = mirrorController().state;
    return state.mobileProjectPaths.has(normalizeProjectPath(this.project.path));
  }

  @Builder
  statusBadge(label: string, bg: string, fg: string) {
    Text(label)
      .fontSize(10)
      .fontWeight(FontWeight.Medium)
      .fontColor(fg)
      .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      .backgroundColor(bg)
      .borderRadius(999)
      .maxLines(1)
  }

  @Builder
  launchSheetView() {
    LaunchSheet({
      project: this.project,
      workspaceName: this.workspaceName,
      onClose: (): void => {
        this.showSheet = false;
      }
    })
  }

  build() {
    Column() {
      if (this.showDivider) {
        Divider()
          .strokeWidth(1)
          .color(currentTheme().divider)
      }

      Row({ space: 8 }) {
        Text('>_')
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().textSecondary)
          .width(18)
          .height(18)
          .textAlign(TextAlign.Center)
        Column({ space: 1 }) {
          Text(this.project.displayName)
            .fontSize(14)
            .fontWeight(500)
            .fontColor(currentTheme().textPrimary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(middleEllipsizePath(this.project.path))
            .fontSize(11)
            .fontColor(currentTheme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.desktopRunning()) {
          this.statusBadge('电脑在跑', currentTheme().primaryDim, currentTheme().primary)
        }
        if (this.mobileOpen()) {
          this.statusBadge('手机打开', currentTheme().tertiaryDim, currentTheme().tertiary)
        }
        Text('›')
          .fontSize(18)
          .fontColor(currentTheme().textSecondary)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .constraintSize({ minHeight: 48 })
      .padding({ top: 8, bottom: 8 })
      .borderRadius(8)
      .backgroundColor(this.pressed ? currentTheme().badgeBg : Color.Transparent)
      .onTouch((event: TouchEvent) => {
        if (event.type === TouchType.Down) {
          this.pressed = true;
        } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
          this.pressed = false;
        }
      })
      .onClick(() => {
        this.showSheet = true;
      })
      .bindSheet(this.showSheet, this.launchSheetView(), {
        height: SheetSize.FIT_CONTENT,
        dragBar: true,
        showClose: false,
        onDisappear: (): void => {
          this.showSheet = false;
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
