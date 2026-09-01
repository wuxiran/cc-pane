import { statusDotColor, statusText } from '../common/Format';
import { AppNav } from '../common/Nav';
import { currentTheme } from '../common/Theme';
import { FailureKind } from '../common/Result';
import { MirrorCard } from '../model/MirrorState';
import { SessionInfo } from '../model/SessionInfo';
import { authController } from '../stores/AuthController';
import { mirrorController } from '../stores/MirrorController';
import { ApiClient } from '../services/ApiClient';
import { SessionsApi } from '../services/SessionsApi';

const EMPTY_INFO: SessionInfo = new SessionInfo('', 'unknown', 0, 0);
const EMPTY_CARD: MirrorCard = new MirrorCard('', '', EMPTY_INFO, undefined, undefined, undefined, false, undefined);

/** 输出预览缓存：sessionId → 最近非空行（进入可视一次性拉取，不随 5s 轮询重拉）。 */
const previewCache: Map<string, string> = new Map();
/** 插入顺序（FIFO 淘汰用）。 */
const previewCacheOrder: string[] = [];
/** 缓存上限：超出清最旧，避免长会话流场景无界增长。 */
const PREVIEW_CACHE_LIMIT = 100;

function cachePreview(sessionId: string, value: string): void {
  if (!previewCache.has(sessionId)) {
    previewCacheOrder.push(sessionId);
  }
  previewCache.set(sessionId, value);
  while (previewCacheOrder.length > PREVIEW_CACHE_LIMIT) {
    let oldest: string | undefined = previewCacheOrder.shift();
    if (oldest === undefined) {
      break;
    }
    previewCache.delete(oldest);
  }
}

/**
 * 镜像会话卡（对齐 Flutter mirror_card.MirrorCardTile）：
 * 11vp 状态点 + 标题 + cliTool 徽标 + 『Pane N·当前』徽标 + 关闭按钮（只读隐藏）；
 * 副行 orphanReason·projectName·statusText；最近输出单行预览（等宽 11fp）。
 */
@ComponentV2
export struct MirrorCardTile {
  @Param card: MirrorCard = EMPTY_CARD;
  @Local preview: string = '';
  @Local previewLoaded: boolean = false;

  /** Grid 懒加载：卡片创建即视为进入可视，一次性拉取预览。 */
  aboutToAppear(): void {
    let cached: string | undefined = previewCache.get(this.card.sessionId);
    if (cached !== undefined) {
      this.preview = cached;
      this.previewLoaded = true;
      return;
    }
    if (!this.previewLoaded) {
      this.loadPreview();
    }
  }

  async loadPreview(): Promise<void> {
    let client: ApiClient | undefined = authController().client;
    if (client === undefined) {
      return;
    }
    let api: SessionsApi = new SessionsApi(client);
    let result = await api.output(this.card.sessionId);
    if (!result.ok || result.value === undefined) {
      this.previewLoaded = true;
      return;
    }
    let found: string = '';
    let lines: string[] = result.value;
    for (let i = lines.length - 1; i >= 0; i--) {
      let trimmed: string = lines[i].trim();
      if (trimmed.length > 0) {
        found = trimmed;
        break;
      }
    }
    cachePreview(this.card.sessionId, found);
    this.preview = found;
    this.previewLoaded = true;
  }

  subtitle(): string {
    let info: SessionInfo = this.card.info;
    let status: string = statusText(info.status, info.exited, info.exitCode, info.currentToolName);
    if (this.card.orphanReason !== undefined) {
      return `${this.card.orphanReason} · ${status}`;
    }
    let project: string | undefined = this.card.projectName;
    if (project !== undefined && project.length > 0 && project !== this.card.title) {
      return `${project} · ${status}`;
    }
    return status;
  }

  hasCliTool(): boolean {
    return this.card.cliTool !== undefined && this.card.cliTool !== 'none';
  }

  paneBadge(): string {
    let suffix: string = this.card.isActiveLeaf ? '·当前' : '';
    return `Pane ${this.card.paneOrdinal}${suffix}`;
  }

  openTerminal(): void {
    let param: Record<string, Object> = {
      'sessionId': this.card.sessionId,
      'title': this.card.title
    };
    AppNav.stack.pushPathByName(AppNav.ROUTE_TERMINAL, param);
  }

  confirmKill(): void {
    this.getUIContext().showAlertDialog({
      title: '关闭会话？',
      message: `将终止「${this.card.title}」及其整棵进程树。`,
      primaryButton: {
        value: '取消',
        action: (): void => {
        }
      },
      secondaryButton: {
        value: '关闭',
        fontColor: currentTheme().error,
        action: (): void => {
          this.kill();
        }
      }
    });
  }

  async kill(): Promise<void> {
    let result = await mirrorController().killSession(this.card.sessionId);
    if (result.ok) {
      return;
    }
    let failure = result.failure;
    let message: string;
    if (failure !== undefined && failure.kind === FailureKind.ReadOnly) {
      message = '远程只读模式已拦截该操作。可在桌面端设置中开启「允许已登录的远程会话写入」。';
    } else {
      message = failure !== undefined ? failure.message : '关闭失败';
    }
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 3000 });
    } catch (err) {
      // 组件已销毁等场景：静默（对齐 WebTerminalBridge.run 的容错策略）
    }
  }

  @Builder
  badge(text: string, bg: string, fg: string) {
    Text(text)
      .fontSize(10)
      .fontColor(fg)
      .padding({ left: 6, right: 6, top: 1, bottom: 1 })
      .backgroundColor(bg)
      .borderRadius(6)
      .maxLines(1)
  }

  build() {
    Row({ space: 2 }) {
      // 可点击内容区（关闭按钮置于其外，避免点击冒泡误触跳转）
      Column({ space: 3 }) {
        Row({ space: 6 }) {
          Circle({ width: 11, height: 11 })
            .fill(statusDotColor(this.card.info.status, this.card.info.exited))
          Text(this.card.title)
            .fontSize(14)
            .fontWeight(600)
            .fontColor(currentTheme().textPrimary)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.hasCliTool()) {
            this.badge(this.card.cliTool !== undefined ? this.card.cliTool : '',
              currentTheme().primaryDim, currentTheme().primary)
          }
          if (this.card.paneOrdinal !== undefined) {
            this.badge(this.paneBadge(), currentTheme().badgeBg, currentTheme().textSecondary)
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text(this.subtitle())
          .fontSize(12)
          .fontColor(currentTheme().textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (this.preview.length > 0) {
          Text(this.preview)
            .fontSize(11)
            .fontFamily('monospace')
            .fontColor(currentTheme().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .padding({ top: 2, bottom: 2 })
      .onClick(() => {
        this.openTerminal();
      })

      if (!authController().readOnly()) {
        Text('×')
          .fontSize(18)
          .fontColor(currentTheme().textSecondary)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.confirmKill();
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ left: 12, right: 8, top: 12, bottom: 12 })
    .borderRadius(14)
    .backgroundColor(currentTheme().card)
    .border({ width: 1, color: currentTheme().divider })
  }
}
