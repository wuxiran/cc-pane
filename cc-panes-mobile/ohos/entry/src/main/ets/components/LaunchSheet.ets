import { AppNav } from '../common/Nav';
import { currentTheme } from '../common/Theme';
import { FailureKind } from '../common/Result';
import { LaunchRecord } from '../model/LaunchRecord';
import { WorkspaceProject } from '../model/Workspace';
import { launchHistoryStore } from '../stores/LaunchHistoryStore';
import { mirrorController } from '../stores/MirrorController';

const EMPTY_PROJECT: WorkspaceProject = new WorkspaceProject('', '', undefined);

/** 启动失败/只读拦截的 toast 文案（对齐 Flutter launch_sheet._launch）。 */
function launchFailureMessage(failureKind: FailureKind | undefined, fallback: string): string {
  if (failureKind === FailureKind.ReadOnly) {
    return '远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。';
  }
  return fallback;
}

/**
 * 项目启动底部弹层（对齐 Flutter launch_sheet）：
 * Claude / Codex / 终端 三按钮 + 该项目最近 5 条可恢复会话。
 * 启动成功 → 关弹层并 push 终端页（参数 { sessionId, title }）。
 */
@ComponentV2
export struct LaunchSheet {
  @Param project: WorkspaceProject = EMPTY_PROJECT;
  @Param workspaceName: string = '';
  @Event onClose: () => void = (): void => {};

  aboutToAppear(): void {
    launchHistoryStore().refresh().catch((): void => {
    });
  }

  recentRecords(): LaunchRecord[] {
    let out: LaunchRecord[] = [];
    for (let record of launchHistoryStore().records) {
      if (out.length >= 5) {
        break;
      }
      if (record.projectPath === this.project.path && record.canResume) {
        out.push(record);
      }
    }
    return out;
  }

  recordTitle(record: LaunchRecord): string {
    if (record.lastPrompt !== undefined && record.lastPrompt.length > 0) {
      return record.lastPrompt;
    }
    let sessionId: string = record.resumeSessionId !== undefined ? record.resumeSessionId : '';
    return `会话 ${sessionId.substring(0, 8)}…`;
  }

  recordDate(record: LaunchRecord): string {
    let parts: string[] = record.launchedAt.split('T');
    return parts.length > 0 ? parts[0] : '';
  }

  async launchWith(cliTool: string, resumeId: string | undefined): Promise<void> {
    let result = await mirrorController().launch(this.project.path, cliTool, this.workspaceName, resumeId);
    if (result.ok && result.value !== undefined) {
      this.onClose();
      let param: Record<string, Object> = {
        'sessionId': result.value,
        'title': this.project.displayName
      };
      AppNav.stack.pushPathByName(AppNav.ROUTE_TERMINAL, param);
      return;
    }
    let failureKind: FailureKind | undefined = result.failure !== undefined ? result.failure.kind : undefined;
    let fallback: string = result.failure !== undefined ? result.failure.message : '启动失败';
    try {
      this.getUIContext().getPromptAction().showToast({ message: launchFailureMessage(failureKind, fallback), duration: 3000 });
    } catch (err) {
      // 组件已销毁等场景：静默（对齐 WebTerminalBridge.run 的容错策略）
    }
  }

  @Builder
  actionButton(label: string, bg: string, fg: string, borderColor: string, cliTool: string) {
    Button(label)
      .layoutWeight(1)
      .height(40)
      .fontSize(14)
      .backgroundColor(bg)
      .fontColor(fg)
      .borderRadius(10)
      .border({ width: borderColor.length > 0 ? 1 : 0, color: borderColor.length > 0 ? borderColor : bg })
      .onClick(() => {
        this.launchWith(cliTool, undefined);
      })
  }

  @Builder
  historyRow(record: LaunchRecord) {
    Row({ space: 10 }) {
      Text(record.cliTool === 'codex' ? 'Codex' : 'Claude')
        .fontSize(10)
        .fontColor(currentTheme().textSecondary)
        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        .backgroundColor(currentTheme().badgeBg)
        .borderRadius(6)
        .maxLines(1)
      Column({ space: 1 }) {
        Text(this.recordTitle(record))
          .fontSize(13)
          .fontColor(currentTheme().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.recordDate(record))
          .fontSize(11)
          .fontColor(currentTheme().textSecondary)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Text('›')
        .fontSize(18)
        .fontColor(currentTheme().textSecondary)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ top: 10, bottom: 10 })
    .borderRadius(8)
    .onClick(() => {
      let cliTool: string = record.cliTool !== undefined ? record.cliTool : 'claude';
      this.launchWith(cliTool, record.resumeSessionId);
    })
  }

  build() {
    Scroll() {
      Column() {
        Text(this.project.displayName)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor(currentTheme().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.project.path)
          .fontSize(12)
          .fontColor(currentTheme().textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })

        Row({ space: 8 }) {
          this.actionButton('Claude', currentTheme().primary, currentTheme().onPrimary, '', 'claude')
          this.actionButton('Codex', currentTheme().primaryDim, currentTheme().primary, currentTheme().primary, 'codex')
          this.actionButton('终端', '#00000000', currentTheme().textPrimary, currentTheme().divider, 'none')
        }
        .width('100%')
        .margin({ top: 12 })

        if (this.recentRecords().length > 0) {
          Text('最近启动（点击恢复会话）')
            .fontSize(12)
            .fontColor(currentTheme().textSecondary)
            .margin({ top: 16, bottom: 4 })
          ForEach(this.recentRecords(), (record: LaunchRecord) => {
            this.historyRow(record)
          }, (record: LaunchRecord) => `${record.id}`)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding({ left: 16, right: 16, top: 4, bottom: 24 })
      .backgroundColor(currentTheme().background)
    }
    .scrollable(ScrollDirection.Vertical)
    .constraintSize({ maxHeight: 560 })
    .width('100%')
  }
}
