import { jsonGetNumber, jsonGetNumberOpt, jsonGetString, jsonGetStringOpt } from '../common/Json';

/**
 * GET /api/sessions 元素（cc-panes-core SessionStatusInfo，camelCase）。
 */
export class SessionInfo {
  readonly sessionId: string;

  /** initializing | idle | thinking | toolRunning | compacting | waitingInput | exited …（未知值原样保留） */
  readonly status: string;
  readonly lastOutputAt: number;
  readonly updatedAt: number;
  readonly pid: number | undefined;
  readonly exitCode: number | undefined;
  readonly currentToolName: string | undefined;
  readonly currentToolSummary: string | undefined;

  constructor(
    sessionId: string,
    status: string,
    lastOutputAt: number,
    updatedAt: number,
    pid?: number,
    exitCode?: number,
    currentToolName?: string,
    currentToolSummary?: string
  ) {
    this.sessionId = sessionId;
    this.status = status;
    this.lastOutputAt = lastOutputAt;
    this.updatedAt = updatedAt;
    this.pid = pid;
    this.exitCode = exitCode;
    this.currentToolName = currentToolName;
    this.currentToolSummary = currentToolSummary;
  }

  get exited(): boolean {
    return this.exitCode !== undefined || this.status === 'exited';
  }

  static fromJson(rec: Record<string, Object>): SessionInfo {
    return new SessionInfo(
      jsonGetString(rec, 'sessionId', ''),
      jsonGetString(rec, 'status', 'unknown'),
      jsonGetNumber(rec, 'lastOutputAt', 0),
      jsonGetNumber(rec, 'updatedAt', 0),
      jsonGetNumberOpt(rec, 'pid'),
      jsonGetNumberOpt(rec, 'exitCode'),
      jsonGetStringOpt(rec, 'currentToolName'),
      jsonGetStringOpt(rec, 'currentToolSummary')
    );
  }
}
