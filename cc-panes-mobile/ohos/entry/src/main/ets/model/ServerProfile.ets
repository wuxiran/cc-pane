import { jsonGetString } from '../common/Json';

/**
 * 一个可连接的桌面端配置（对齐 Dart server_profile.dart）。
 * 密码需保存以支持 cookie 过期后的静默重登。
 */
export class ServerProfile {
  readonly id: string;
  readonly name: string;

  /** 形如 `http://192.168.1.5:18080` 或 `https://host.tailnet.ts.net`，无尾斜杠。 */
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;

  constructor(id: string, name: string, baseUrl: string, username: string, password: string) {
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }

  static fromJson(rec: Record<string, Object>): ServerProfile {
    return new ServerProfile(
      jsonGetString(rec, 'id', ''),
      jsonGetString(rec, 'name', ''),
      jsonGetString(rec, 'baseUrl', ''),
      jsonGetString(rec, 'username', ''),
      jsonGetString(rec, 'password', '')
    );
  }

  toJson(): Record<string, Object> {
    let out: Record<string, Object> = {
      'id': this.id,
      'name': this.name,
      'baseUrl': this.baseUrl,
      'username': this.username,
      'password': this.password
    };
    return out;
  }

  /** 规范化用户输入：补 scheme、去尾斜杠。 */
  static normalizeBaseUrl(input: string): string {
    let url: string = input.trim();
    if (url.length === 0) {
      return url;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    return url;
  }
}
