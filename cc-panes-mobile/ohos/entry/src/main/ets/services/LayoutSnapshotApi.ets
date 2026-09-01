import { http } from '@kit.NetworkKit';
import { Result } from '../common/Result';
import { asRecord } from '../common/Json';
import { LayoutSnapshot } from '../model/LayoutSnapshot';
import { ApiClient } from './ApiClient';

/**
 * GET /api/layout-snapshot/{profileId} —— 电脑当前布局镜像。
 * MVP 固定 profileId="default"。
 */
export class LayoutSnapshotApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  /** 返回快照；桌面前端从未落库时后端可能返回空 body / null，此时得到 undefined。 */
  fetch(profileId: string = 'default'): Promise<Result<LayoutSnapshot | undefined>> {
    return this.client.requestJson<LayoutSnapshot | undefined>(
      http.RequestMethod.GET,
      `/api/layout-snapshot/${profileId}`,
      (root: Object | null): LayoutSnapshot | undefined => {
        if (root === null) {
          return undefined;
        }
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          return undefined;
        }
        return LayoutSnapshot.fromJson(rec);
      }
    );
  }
}
