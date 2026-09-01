import { jsonGetBool, jsonGetRecords, jsonGetString, jsonGetStringOpt } from '../common/Json';
import { pathBasename } from '../common/Format';

/**
 * GET /api/workspaces 元素（web/types/workspace.ts 的 Workspace）。
 */
export class Workspace {
  readonly id: string;
  readonly name: string;
  readonly alias: string | undefined;
  readonly path: string | undefined;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly projects: WorkspaceProject[];

  constructor(
    id: string,
    name: string,
    alias: string | undefined,
    path: string | undefined,
    pinned: boolean,
    hidden: boolean,
    projects: WorkspaceProject[]
  ) {
    this.id = id;
    this.name = name;
    this.alias = alias;
    this.path = path;
    this.pinned = pinned;
    this.hidden = hidden;
    this.projects = projects;
  }

  get displayName(): string {
    return this.alias !== undefined && this.alias.length > 0 ? this.alias : this.name;
  }

  get projectCount(): number {
    return this.projects.length;
  }

  static fromJson(rec: Record<string, Object>): Workspace {
    let id: string = jsonGetString(rec, 'id', '');
    if (id.length === 0) {
      id = jsonGetString(rec, 'name', '');
    }
    let projects: WorkspaceProject[] = [];
    let projectRecs: Record<string, Object>[] = jsonGetRecords(rec, 'projects');
    for (let item of projectRecs) {
      projects.push(WorkspaceProject.fromJson(item));
    }
    return new Workspace(
      id,
      jsonGetString(rec, 'name', ''),
      jsonGetStringOpt(rec, 'alias'),
      jsonGetStringOpt(rec, 'path'),
      jsonGetBool(rec, 'pinned', false),
      jsonGetBool(rec, 'hidden', false),
      projects
    );
  }
}

export class WorkspaceProject {
  readonly id: string;
  readonly path: string;
  readonly alias: string | undefined;

  constructor(id: string, path: string, alias: string | undefined) {
    this.id = id;
    this.path = path;
    this.alias = alias;
  }

  get displayName(): string {
    return this.alias !== undefined && this.alias.length > 0 ? this.alias : pathBasename(this.path);
  }

  static fromJson(rec: Record<string, Object>): WorkspaceProject {
    return new WorkspaceProject(
      jsonGetString(rec, 'id', ''),
      jsonGetString(rec, 'path', ''),
      jsonGetStringOpt(rec, 'alias')
    );
  }
}
