import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { AppConfig } from '../common/Config';
import { AppContext } from '../common/AppContext';
import { ApiFailure, Err, FailureKind, Ok, Result } from '../common/Result';
import { ServerProfile } from '../model/ServerProfile';

const COOKIE_PREF_NAME = 'cc_panes_api';
const COOKIE_NAME_PREFIX = 'ccp_web_session=';
/** Asset Store 的 cookie 别名前缀（按 profile id 分键，切换服务器互不污染）。 */
const COOKIE_ASSET_PREFIX = 'ccp_cookie_';

/**
 * 单个 ServerProfile 的 HTTP 客户端（对齐 Dart api_client.dart + dio 拦截器）：
 * - 每请求 createHttp / finally destroy；
 * - 手动 Cookie 管理：从响应头 set-cookie 提取 ccp_web_session=...（值可能是 string 或数组，
 *   header 键大小写不定需遍历），后续请求与 WS 握手都带 Cookie 头；
 * - cookie 持久化到 Asset Store（alias 按 profile id 分键，切换服务器互不污染；Asset 失败降级 preferences）；
 * - guard() 错误映射：网络异常→network、401→unauthorized、403+READ_ONLY→readOnly、
 *   403 其他→remoteForbidden、其他非 2xx→http、解析异常→local。
 * 实例可重建：connectWith 换 profile 时由 AuthController 整体替换本实例。
 */
export class ApiClient {
  private readonly profileValue: ServerProfile;
  private cookieValue: string;

  /**
   * 收到 403 READ_ONLY 时的通知钩子（由 AuthController 注入，重拉 status 收紧 readOnly）；
   * 触发不影响本请求的 Result 返回。缺省无监听。
   */
  onReadOnlyDetected?: () => void = undefined;

  constructor(profile: ServerProfile, cookie: string) {
    this.profileValue = profile;
    this.cookieValue = cookie;
  }

  /** 创建并加载该 profile 持久化的 cookie（无则空串）。 */
  static async create(profile: ServerProfile): Promise<ApiClient> {
    let cookie: string = await loadCookie(profile.id);
    return new ApiClient(profile, cookie);
  }

  baseUrl(): string {
    return this.profileValue.baseUrl;
  }

  profile(): ServerProfile {
    return this.profileValue;
  }

  /** 当前会话 cookie 头（供 WebSocket 握手复用）；无 cookie 返回 undefined。 */
  sessionCookieHeader(): string | undefined {
    return this.cookieValue.length > 0 ? this.cookieValue : undefined;
  }

  private buildHeader(hasBody: boolean): Record<string, string> {
    let header: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (hasBody) {
      header['Content-Type'] = 'application/json';
    }
    if (this.cookieValue.length > 0) {
      header['Cookie'] = this.cookieValue;
    }
    return header;
  }

  /** 从 set-cookie 响应头提取 ccp_web_session（header 值可能是 string 或 string[]）。 */
  private captureCookie(header: Object | undefined): void {
    if (header === undefined || header === null) {
      return;
    }
    let rec: Record<string, Object> = header as Record<string, Object>;
    let keys: string[] = Object.keys(rec);
    for (let key of keys) {
      if (key.toLowerCase() !== 'set-cookie') {
        continue;
      }
      let value: Object | undefined = rec[key];
      let cookies: string[] = [];
      if (typeof value === 'string') {
        cookies.push(value as string);
      } else if (Array.isArray(value)) {
        let list: Object[] = value as Object[];
        for (let item of list) {
          if (typeof item === 'string') {
            cookies.push(item as string);
          }
        }
      }
      for (let raw of cookies) {
        let seg: string = raw.split(';')[0].trim();
        if (seg.startsWith(COOKIE_NAME_PREFIX) && seg.length > COOKIE_NAME_PREFIX.length) {
          this.cookieValue = seg;
          this.persistCookie();
        }
      }
    }
  }

  private persistCookie(): void {
    let profileId: string = this.profileValue.id;
    let cookie: string = this.cookieValue;
    saveCookie(profileId, cookie);
  }

  /** 响应体为 JSON 对象时的 message 字段 / 纯文本兜底（对齐 Dart _errorMessage）。 */
  private bodyMessage(text: string): string | undefined {
    let rec: Record<string, Object> | undefined = this.errorPayload(text);
    if (rec !== undefined) {
      let message: Object | undefined = rec['message'];
      return typeof message === 'string' ? message as string : undefined;
    }
    return text.trim().length > 0 ? text : undefined;
  }

  private bodyErrorCode(text: string): string | undefined {
    let rec: Record<string, Object> | undefined = this.errorPayload(text);
    if (rec !== undefined) {
      let code: Object | undefined = rec['code'];
      return typeof code === 'string' ? code as string : undefined;
    }
    return undefined;
  }

  private errorPayload(text: string): Record<string, Object> | undefined {
    if (text.length === 0) {
      return undefined;
    }
    try {
      let root: Object | null = JSON.parse(text) as Object | null;
      if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
        return root as Record<string, Object>;
      }
    } catch (err) {
      // 非 JSON 体（纯文本错误页等）→ 由调用方按原始文本兜底
    }
    return undefined;
  }

  /**
   * 统一请求入口（对齐 Dart guard()）：4xx/5xx 不抛异常，归类为 ApiFailure；
   * 2xx 时把 JSON 根对象（空 body → null）交给 parse 回调，parse 抛异常归类为 local。
   */
  async requestJson<T>(
    method: http.RequestMethod,
    path: string,
    parse: (root: Object | null) => T,
    body?: Record<string, Object>
  ): Promise<Result<T>> {
    let req: http.HttpRequest = http.createHttp();
    let status: number = 0;
    let text: string = '';
    let networkMessage: string | undefined = undefined;
    try {
      let options: http.HttpRequestOptions = {
        method: method,
        header: this.buildHeader(body !== undefined),
        connectTimeout: AppConfig.HTTP_TIMEOUT_MS,
        readTimeout: AppConfig.HTTP_TIMEOUT_MS,
        expectDataType: http.HttpDataType.STRING
      };
      if (body !== undefined) {
        options.extraData = JSON.stringify(body);
      }
      let resp: http.HttpResponse = await req.request(this.profileValue.baseUrl + path, options);
      status = resp.responseCode;
      let result: Object | undefined = resp.result as Object | undefined;
      text = result === undefined || result === null ? '' : result as string;
      this.captureCookie(resp.header);
    } catch (err) {
      let e: BusinessError = err as BusinessError;
      networkMessage = e.message !== undefined && e.message.length > 0 ? e.message : '网络请求失败';
    } finally {
      req.destroy();
    }

    if (networkMessage !== undefined) {
      return Err(new ApiFailure(FailureKind.Network, networkMessage));
    }
    if (status === 401) {
      return Err(new ApiFailure(FailureKind.Unauthorized, '会话已过期，请重新登录', status));
    }
    if (status === 403) {
      let code: string | undefined = this.bodyErrorCode(text);
      let kind: FailureKind = code === 'READ_ONLY' ? FailureKind.ReadOnly : FailureKind.RemoteForbidden;
      if (kind === FailureKind.ReadOnly && this.onReadOnlyDetected !== undefined) {
        try {
          this.onReadOnlyDetected();
        } catch (err) {
          // 钩子异常不打断 guard 分类
        }
      }
      let message: string | undefined = this.bodyMessage(text);
      return Err(new ApiFailure(kind, message !== undefined ? message : '访问被拒绝', status));
    }
    if (status < 200 || status >= 300) {
      let message: string | undefined = this.bodyMessage(text);
      return Err(new ApiFailure(FailureKind.Http, message !== undefined ? message : `HTTP ${status}`, status));
    }

    try {
      let root: Object | null = null;
      if (text.trim().length > 0) {
        root = JSON.parse(text) as Object | null;
      }
      return Ok(parse(root));
    } catch (err) {
      let detail: string = err instanceof Error && err.message !== undefined ? err.message : `${err}`;
      return Err(new ApiFailure(FailureKind.Local, `响应解析失败: ${detail}`));
    }
  }
}

async function cookiePrefStore(): Promise<preferences.Preferences | undefined> {
  let ctx = AppContext.holder;
  if (ctx === undefined) {
    return undefined;
  }
  try {
    return await preferences.getPreferences(ctx, { name: COOKIE_PREF_NAME });
  } catch (err) {
    return undefined;
  }
}

function strToBytes(s: string): Uint8Array {
  return new util.TextEncoder().encodeInto(s);
}

function bytesToStr(bytes: Uint8Array): string {
  return util.TextDecoder.create('utf-8').decodeToString(bytes);
}

/** Asset Store 读取（参考 ServerStore 写法）；无记录/失败返回 undefined（调用方降级 preferences）。 */
async function assetGetCookie(alias: string): Promise<string | undefined> {
  try {
    let query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, strToBytes(alias));
    // 注：本 SDK 版本 Tag 无 RETURN_ALL；query 缺省 RETURN_TYPE=ALL，返回含 SECRET 的全部属性。
    let results: asset.AssetMap[] = await asset.query(query);
    if (results.length === 0) {
      return undefined;
    }
    let secret: boolean | number | Uint8Array | undefined = results[0].get(asset.Tag.SECRET);
    if (secret instanceof Uint8Array) {
      return bytesToStr(secret);
    }
    return undefined;
  } catch (err) {
    console.error(`[ApiClient] assetGetCookie(${alias}) failed: ${err}`);
    return undefined;
  }
}

/** Asset Store 写入（add 冲突改走 update 覆盖）；成功 true / 失败 false（调用方降级 preferences）。 */
async function assetPutCookie(alias: string, value: string): Promise<boolean> {
  let aliasBytes: Uint8Array = strToBytes(alias);
  let secretBytes: Uint8Array = strToBytes(value);
  try {
    let attrs: asset.AssetMap = new Map();
    attrs.set(asset.Tag.ALIAS, aliasBytes);
    attrs.set(asset.Tag.SECRET, secretBytes);
    attrs.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    await asset.add(attrs);
    return true;
  } catch (addErr) {
    // 已存在（或冲突）→ 改走 update(query, attributes) 覆盖
    try {
      let query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, aliasBytes);
      let update: asset.AssetMap = new Map();
      update.set(asset.Tag.SECRET, secretBytes);
      await asset.update(query, update);
      return true;
    } catch (updateErr) {
      console.error(`[ApiClient] assetPutCookie(${alias}) failed: ${updateErr}`);
      return false;
    }
  }
}

/**
 * 读取持久化 cookie：Asset Store 优先；无记录/失败降级 preferences
 * （兼作旧版 preferences 数据的迁移来源，下次写入即落到 Asset）。
 */
async function loadCookie(profileId: string): Promise<string> {
  let fromAsset: string | undefined = await assetGetCookie(`${COOKIE_ASSET_PREFIX}${profileId}`);
  if (fromAsset !== undefined) {
    return fromAsset;
  }
  let store: preferences.Preferences | undefined = await cookiePrefStore();
  if (store === undefined) {
    return '';
  }
  try {
    let value: preferences.ValueType = await store.get(`cookie_${profileId}`, '');
    return typeof value === 'string' ? value as string : '';
  } catch (err) {
    return '';
  }
}

/** 写入 cookie：Asset Store 优先，失败降级 preferences（均异步不阻塞请求）。 */
function saveCookie(profileId: string, cookie: string): void {
  assetPutCookie(`${COOKIE_ASSET_PREFIX}${profileId}`, cookie)
    .then((viaAsset: boolean): void => {
      if (!viaAsset) {
        saveCookieToPrefs(profileId, cookie);
      }
    })
    .catch((): void => {
      saveCookieToPrefs(profileId, cookie);
    });
}

function saveCookieToPrefs(profileId: string, cookie: string): void {
  cookiePrefStore().then((store: preferences.Preferences | undefined): void => {
    if (store === undefined) {
      return;
    }
    store.put(`cookie_${profileId}`, cookie).catch((): void => {
    });
  }).catch((): void => {
  });
}
