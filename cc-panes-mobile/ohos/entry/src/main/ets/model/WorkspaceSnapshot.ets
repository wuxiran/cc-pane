import { jsonGetNumber, jsonGetRecords, jsonGetString, jsonGetStringOpt } from '../common/Json';

/**
 * GET /api/workspace-snapshots/{workspaceId} 元素（WorkspaceSnapshotSummary）。
 */
export class WorkspaceSnapshotSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly savedAt: string;
  readonly entryCount: number;

  constructor(id: string, workspaceId: string, title: string, savedAt: string, entryCount: number) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.title = title;
    this.savedAt = savedAt;
    this.entryCount = entryCount;
  }

  static fromJson(rec: Record<string, Object>): WorkspaceSnapshotSummary {
    return new WorkspaceSnapshotSummary(
      jsonGetString(rec, 'id', ''),
      jsonGetString(rec, 'workspaceId', ''),
      jsonGetString(rec, 'title', ''),
      jsonGetString(rec, 'savedAt', ''),
      jsonGetNumber(rec, 'entryCount', 0)
    );
  }
}

/** POST .../restore 响应的单条结果。 */
export class RestoredSnapshotEntry {
  readonly projectPath: string;
  readonly cliTool: string;
  readonly sessionId: string | undefined;
  readonly customTitle: string | undefined;
  readonly error: string | undefined;

  constructor(
    projectPath: string,
    cliTool: string,
    sessionId: string | undefined,
    customTitle: string | undefined,
    error: string | undefined
  ) {
    this.projectPath = projectPath;
    this.cliTool = cliTool;
    this.sessionId = sessionId;
    this.customTitle = customTitle;
    this.error = error;
  }

  get succeeded(): boolean {
    return this.sessionId !== undefined && this.error === undefined;
  }

  static fromJson(rec: Record<string, Object>): RestoredSnapshotEntry {
    return new RestoredSnapshotEntry(
      jsonGetString(rec, 'projectPath', ''),
      jsonGetString(rec, 'cliTool', 'none'),
      jsonGetStringOpt(rec, 'sessionId'),
      jsonGetStringOpt(rec, 'customTitle'),
      jsonGetStringOpt(rec, 'error')
    );
  }
}

export class RestoreSnapshotResult {
  readonly snapshotId: string;
  readonly entries: RestoredSnapshotEntry[];

  constructor(snapshotId: string, entries: RestoredSnapshotEntry[]) {
    this.snapshotId = snapshotId;
    this.entries = entries;
  }

  get succeededCount(): number {
    let count: number = 0;
    for (let entry of this.entries) {
      if (entry.succeeded) {
        count++;
      }
    }
    return count;
  }

  static fromJson(rec: Record<string, Object>): RestoreSnapshotResult {
    let entries: RestoredSnapshotEntry[] = [];
    let entryRecs: Record<string, Object>[] = jsonGetRecords(rec, 'entries');
    for (let item of entryRecs) {
      entries.push(RestoredSnapshotEntry.fromJson(item));
    }
    return new RestoreSnapshotResult(jsonGetString(rec, 'snapshotId', ''), entries);
  }
}
