import { http } from '@kit.NetworkKit';
import { AppConfig } from '../common/Config';
import { Result } from '../common/Result';
import { asArray, asRecord, jsonGetString, jsonGetStringOpt } from '../common/Json';
import { SessionInfo } from '../model/SessionInfo';
import { ApiClient } from './ApiClient';

/** /api/sessions —— 终端会话 CRUD 与输入输出（REST 部分）。 */
export class SessionsApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  list(): Promise<Result<SessionInfo[]>> {
    return this.client.requestJson<SessionInfo[]>(
      http.RequestMethod.GET,
      '/api/sessions',
      (root: Object | null): SessionInfo[] => {
        let arr: Object[] | undefined = asArray(root);
        if (arr === undefined) {
          throw new Error('响应不是 JSON 数组');
        }
        let out: SessionInfo[] = [];
        for (let item of arr) {
          let rec: Record<string, Object> | undefined = asRecord(item);
          if (rec !== undefined) {
            out.push(SessionInfo.fromJson(rec));
          }
        }
        return out;
      }
    );
  }

  /**
   * 新建会话。契约同 web 前端 CreateSessionRequest：
   * - Claude/Codex：cliTool + launchClaude=true（可带 resumeId 恢复历史会话）
   * - 纯终端：cliTool="none"、launchClaude=false
   */
  create(
    projectPath: string,
    cliTool: string = 'none',
    launchClaude: boolean = false,
    workspaceName?: string,
    resumeId?: string,
    cols: number = AppConfig.DEFAULT_COLS,
    rows: number = AppConfig.DEFAULT_ROWS
  ): Promise<Result<string>> {
    let body: Record<string, Object> = {
      'projectPath': projectPath,
      'cols': cols,
      'rows': rows,
      'cliTool': cliTool,
      'launchClaude': launchClaude
    };
    if (workspaceName !== undefined) {
      body['workspaceName'] = workspaceName;
    }
    if (resumeId !== undefined) {
      body['resumeId'] = resumeId;
    }
    return this.client.requestJson<string>(
      http.RequestMethod.POST,
      '/api/sessions',
      (root: Object | null): string => {
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          throw new Error('响应不是 JSON 对象');
        }
        let sessionId: string | undefined = jsonGetStringOpt(rec, 'sessionId');
        if (sessionId === undefined || sessionId.length === 0) {
          throw new Error('missing sessionId');
        }
        return sessionId;
      },
      body
    );
  }

  kill(sessionId: string): Promise<Result<void>> {
    return this.client.requestJson<void>(
      http.RequestMethod.DELETE,
      `/api/sessions/${sessionId}`,
      (root: Object | null): void => {
        return;
      }
    );
  }

  /** 最近 N 行纯文本输出（卡片预览用；ANSI 已剥离）。 */
  output(sessionId: string, lines: number = AppConfig.OUTPUT_PREVIEW_LINES): Promise<Result<string[]>> {
    return this.client.requestJson<string[]>(
      http.RequestMethod.GET,
      `/api/sessions/${sessionId}/output?lines=${lines}`,
      (root: Object | null): string[] => {
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          throw new Error('响应不是 JSON 对象');
        }
        let rawLines: Object | undefined = rec['lines'];
        let out: string[] = [];
        if (rawLines !== undefined && Array.isArray(rawLines)) {
          let arr: Object[] = rawLines as Object[];
          for (let item of arr) {
            if (typeof item === 'string') {
              out.push(item as string);
            } else if (typeof item === 'number' || typeof item === 'boolean') {
              out.push(`${item}`);
            }
          }
        }
        return out;
      }
    );
  }

  /** VT 回放快照（attach 时初始化终端内容；空 body / 无 data 字段返回空串）。 */
  snapshot(sessionId: string): Promise<Result<string>> {
    return this.client.requestJson<string>(
      http.RequestMethod.GET,
      `/api/sessions/${sessionId}/snapshot`,
      (root: Object | null): string => {
        if (root === null) {
          return '';
        }
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          return '';
        }
        return jsonGetString(rec, 'data', '');
      }
    );
  }

  resize(sessionId: string, cols: number, rows: number): Promise<Result<void>> {
    let body: Record<string, Object> = {
      'cols': cols,
      'rows': rows
    };
    return this.client.requestJson<void>(
      http.RequestMethod.POST,
      `/api/sessions/${sessionId}/resize`,
      (root: Object | null): void => {
        return;
      },
      body
    );
  }
}
