import { jsonGetString, jsonGetStringOpt } from '../common/Json';
import { pathBasename } from '../common/Format';

/**
 * GET /api/terminal-sessions 元素（web/types/session-restore.ts 的 SavedSession）。
 * 会话 ↔ 项目/标题/CLI 的关联主表；也用作本端 launch 会话的元数据（localMeta）。
 */
export class SavedSession {
  readonly sessionId: string;
  readonly projectPath: string;

  /** 桌面标签页 / 分屏归属：同一 tabId 的会话在桌面属于同一个标签页（可能多分屏）。 */
  readonly tabId: string | undefined;
  readonly paneId: string | undefined;
  readonly workspaceName: string | undefined;
  readonly cliTool: string | undefined;
  readonly customTitle: string | undefined;
  readonly resumeId: string | undefined;

  constructor(
    sessionId: string,
    projectPath: string,
    tabId?: string,
    paneId?: string,
    workspaceName?: string,
    cliTool?: string,
    customTitle?: string,
    resumeId?: string
  ) {
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.tabId = tabId;
    this.paneId = paneId;
    this.workspaceName = workspaceName;
    this.cliTool = cliTool;
    this.customTitle = customTitle;
    this.resumeId = resumeId;
  }

  get displayTitle(): string {
    return this.customTitle !== undefined && this.customTitle.length > 0
      ? this.customTitle
      : pathBasename(this.projectPath);
  }

  static fromJson(rec: Record<string, Object>): SavedSession {
    return new SavedSession(
      jsonGetString(rec, 'sessionId', ''),
      jsonGetString(rec, 'projectPath', ''),
      jsonGetStringOpt(rec, 'tabId'),
      jsonGetStringOpt(rec, 'paneId'),
      jsonGetStringOpt(rec, 'workspaceName'),
      jsonGetStringOpt(rec, 'cliTool'),
      jsonGetStringOpt(rec, 'customTitle'),
      jsonGetStringOpt(rec, 'resumeId')
    );
  }
}
