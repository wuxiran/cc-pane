import { LaunchRecord } from '../model/LaunchRecord';
import { HistoryApi } from '../services/HistoryApi';
import { AuthPhase, authController } from './AuthController';

let instance: LaunchHistoryStore | undefined = undefined;

export function launchHistoryStore(): LaunchHistoryStore {
  if (instance === undefined) {
    instance = new LaunchHistoryStore();
  }
  return instance;
}

/**
 * 全量启动历史（对齐 Dart launchHistoryProvider）：
 * limit=100；launch sheet 按 projectPath 过滤展示；失败置空列表不报错。
 */
@ObservedV2
export class LaunchHistoryStore {
  @Trace records: LaunchRecord[] = [];

  async refresh(): Promise<void> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      this.records = [];
      return;
    }
    let result = await new HistoryApi(client).launchHistory();
    if (result.ok && result.value !== undefined) {
      this.records = result.value;
    } else {
      this.records = [];
    }
  }
}
