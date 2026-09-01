import { FailureKind } from '../common/Result';
import { currentTheme } from '../common/Theme';
import { Workspace, WorkspaceProject } from '../model/Workspace';
import { workspacesController } from '../stores/WorkspacesController';

const EMPTY_WORKSPACE: Workspace = new Workspace('', '', undefined, undefined, false, false, []);

/**
 * 工作区操作弹层（对齐 Flutter workspace_actions_sheet + 修复缺失的「恢复上次布局」入口）：
 * - 打开终端：无项目禁用（『当前工作空间没有项目』），有则打开第一个项目；
 * - 恢复上次布局：按快照重建一组会话（resume 续接对话），toast 三态反馈；
 * - 置顶/别名/重命名/删除/打开文件夹等桌面端能力仅提示。
 */
@ComponentV2
export struct WorkspaceActionsSheet {
  @Param workspace: Workspace = EMPTY_WORKSPACE;
  @Event onClose: () => void = (): void => {};
  @Event onOpenTerminal: (project: WorkspaceProject) => void = (project: WorkspaceProject): void => {};
  @Local restoring: boolean = false;

  hasProjects(): boolean {
    return this.workspace.projects.length > 0;
  }

  hasPath(): boolean {
    return this.workspace.path !== undefined && this.workspace.path.length > 0;
  }

  openTerminal(): void {
    if (!this.hasProjects()) {
      return;
    }
    this.onOpenTerminal(this.workspace.projects[0]);
  }

  async restoreLatest(): Promise<void> {
    if (this.restoring) {
      return;
    }
    this.restoring = true;
    let message: string;
    let result = await workspacesController().restoreLatestSnapshot(this.workspace);
    if (result === undefined) {
      message = '该工作空间没有可恢复的布局快照';
    } else if (!result.ok || result.value === undefined) {
      let failure = result.failure;
      if (failure !== undefined && failure.kind === FailureKind.ReadOnly) {
        message = '远程只读模式已拦截该操作。可在桌面端设置中开启「允许已登录的远程会话写入」。';
      } else {
        message = failure !== undefined ? failure.message : '恢复失败';
      }
    } else {
      let okCount: number = result.value.succeededCount;
      let failCount: number = result.value.entries.length - okCount;
      if (failCount <= 0) {
        message = `已恢复 ${okCount} 个会话`;
      } else {
        message = `恢复 ${okCount} 个成功、${failCount} 个失败（详见会话列表）`;
      }
    }
    this.restoring = false;
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 3000 });
    } catch (err) {
      // 组件已销毁等场景：静默（对齐 WebTerminalBridge.run 的容错策略）
    }
  }

  build() {
    Column() {
      Text('工作区操作')
        .fontSize(12)
        .fontColor(currentTheme().textSecondary)
      Text(this.workspace.displayName)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(currentTheme().textPrimary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 2 })
      if (this.hasPath()) {
        Text(this.workspace.path)
          .fontSize(12)
          .fontColor(currentTheme().textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }

      // 打开终端（无项目禁用）
      Row({ space: 10 }) {
        Text('>_')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().textSecondary)
          .width(24)
          .textAlign(TextAlign.Center)
        Column({ space: 2 }) {
          Text('打开终端')
            .fontSize(15)
            .fontColor(this.hasProjects() ? currentTheme().textPrimary : currentTheme().textSecondary)
          Text(this.hasProjects()
            ? `打开第一个项目 ${this.workspace.projects[0].displayName}`
            : '当前工作空间没有项目')
            .fontSize(12)
            .fontColor(currentTheme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        Text('›')
          .fontSize(18)
          .fontColor(currentTheme().textSecondary)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ top: 14, bottom: 12 })
      .opacity(this.hasProjects() ? 1 : 0.5)
      .onClick(() => {
        this.openTerminal();
      })

      Divider()
        .color(currentTheme().divider)

      // 恢复上次布局（Flutter 版缺失的入口，本次补上）
      Row({ space: 10 }) {
        Text('▦')
          .fontSize(14)
          .fontColor(currentTheme().textSecondary)
          .width(24)
          .textAlign(TextAlign.Center)
        Column({ space: 2 }) {
          Text('恢复上次布局')
            .fontSize(15)
            .fontColor(currentTheme().textPrimary)
          Text('按快照重建一组会话（resume 续接对话）')
            .fontSize(12)
            .fontColor(currentTheme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.restoring) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(currentTheme().primary)
        } else {
          Text('›')
            .fontSize(18)
            .fontColor(currentTheme().textSecondary)
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ top: 12, bottom: 12 })
      .onClick(() => {
        this.restoreLatest();
      })

      Divider()
        .color(currentTheme().divider)

      Text('置顶 / 别名 / 重命名 / 删除 / 打开文件夹等请在桌面端操作')
        .fontSize(12)
        .fontColor(currentTheme().textSecondary)
        .margin({ top: 12, bottom: 8 })
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 16, right: 16, top: 4, bottom: 24 })
    .backgroundColor(currentTheme().background)
  }
}
