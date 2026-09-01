import { jsonGetNumber, jsonGetString, jsonGetStringOpt } from '../common/Json';

/**
 * GET /api/launch-history 元素（web/services/historyService.ts 的 LaunchRecord）。
 */
export class LaunchRecord {
  readonly id: number;
  readonly projectName: string;
  readonly projectPath: string;
  readonly launchedAt: string;
  readonly resumeSessionId: string | undefined;
  readonly cliTool: string | undefined;
  readonly lastPrompt: string | undefined;
  readonly workspaceName: string | undefined;

  constructor(
    id: number,
    projectName: string,
    projectPath: string,
    launchedAt: string,
    resumeSessionId: string | undefined,
    cliTool: string | undefined,
    lastPrompt: string | undefined,
    workspaceName: string | undefined
  ) {
    this.id = id;
    this.projectName = projectName;
    this.projectPath = projectPath;
    this.launchedAt = launchedAt;
    this.resumeSessionId = resumeSessionId;
    this.cliTool = cliTool;
    this.lastPrompt = lastPrompt;
    this.workspaceName = workspaceName;
  }

  get canResume(): boolean {
    return this.resumeSessionId !== undefined && this.resumeSessionId.length > 0;
  }

  static fromJson(rec: Record<string, Object>): LaunchRecord {
    return new LaunchRecord(
      jsonGetNumber(rec, 'id', 0),
      jsonGetString(rec, 'projectName', ''),
      jsonGetString(rec, 'projectPath', ''),
      jsonGetString(rec, 'launchedAt', ''),
      jsonGetStringOpt(rec, 'resumeSessionId'),
      jsonGetStringOpt(rec, 'cliTool'),
      jsonGetStringOpt(rec, 'lastPrompt'),
      jsonGetStringOpt(rec, 'workspaceName')
    );
  }
}
