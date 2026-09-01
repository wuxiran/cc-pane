import { http } from '@kit.NetworkKit';
import { Result } from '../common/Result';
import { asRecord, jsonGetBool } from '../common/Json';
import { AuthStatus } from '../model/AuthStatus';
import { ApiClient } from './ApiClient';

/** /api/auth/* —— 登录态与登录（cookie 由 ApiClient 手动管理）。 */
export class AuthApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  status(): Promise<Result<AuthStatus>> {
    return this.client.requestJson<AuthStatus>(
      http.RequestMethod.GET,
      '/api/auth/status',
      (root: Object | null): AuthStatus => {
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          throw new Error('响应不是 JSON 对象');
        }
        return AuthStatus.fromJson(rec);
      }
    );
  }

  login(username: string, password: string): Promise<Result<boolean>> {
    let body: Record<string, Object> = {
      'username': username,
      'password': password
    };
    return this.client.requestJson<boolean>(
      http.RequestMethod.POST,
      '/api/auth/login',
      (root: Object | null): boolean => {
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          throw new Error('响应不是 JSON 对象');
        }
        return jsonGetBool(rec, 'authenticated', false);
      },
      body
    );
  }
}
