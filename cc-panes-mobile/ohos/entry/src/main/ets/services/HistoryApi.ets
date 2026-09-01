import { http } from '@kit.NetworkKit';
import { AppConfig } from '../common/Config';
import { Result } from '../common/Result';
import { asArray, asRecord } from '../common/Json';
import { LaunchRecord } from '../model/LaunchRecord';
import { SavedSession } from '../model/SavedSession';
import { ApiClient } from './ApiClient';

/** /api/launch-history + /api/terminal-sessions —— 启动历史与会话关联表。 */
export class HistoryApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  launchHistory(limit: number = AppConfig.LAUNCH_HISTORY_LIMIT): Promise<Result<LaunchRecord[]>> {
    return this.client.requestJson<LaunchRecord[]>(
      http.RequestMethod.GET,
      `/api/launch-history?limit=${limit}`,
      (root: Object | null): LaunchRecord[] => {
        let arr: Object[] | undefined = asArray(root);
        if (arr === undefined) {
          throw new Error('响应不是 JSON 数组');
        }
        let out: LaunchRecord[] = [];
        for (let item of arr) {
          let rec: Record<string, Object> | undefined = asRecord(item);
          if (rec !== undefined) {
            out.push(LaunchRecord.fromJson(rec));
          }
        }
        return out;
      }
    );
  }

  terminalSessions(): Promise<Result<SavedSession[]>> {
    return this.client.requestJson<SavedSession[]>(
      http.RequestMethod.GET,
      '/api/terminal-sessions',
      (root: Object | null): SavedSession[] => {
        let arr: Object[] | undefined = asArray(root);
        if (arr === undefined) {
          throw new Error('响应不是 JSON 数组');
        }
        let out: SavedSession[] = [];
        for (let item of arr) {
          let rec: Record<string, Object> | undefined = asRecord(item);
          if (rec !== undefined) {
            out.push(SavedSession.fromJson(rec));
          }
        }
        return out;
      }
    );
  }
}
