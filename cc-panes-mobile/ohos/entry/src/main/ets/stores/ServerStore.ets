import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { asRecord } from '../common/Json';
import { ServerProfile } from '../model/ServerProfile';

const PROFILES_ALIAS = 'server_profiles';
const CURRENT_ID_ALIAS = 'current_profile_id';

function strToBytes(s: string): Uint8Array {
  return new util.TextEncoder().encodeInto(s);
}

function bytesToStr(bytes: Uint8Array): string {
  return util.TextDecoder.create('utf-8').decodeToString(bytes);
}

/**
 * profile 持久化（Asset Store 安全存储，等价 flutter_secure_storage）。
 * 存储失败（设备/系统不支持）时静默降级为内存态，不阻塞连接流程。
 */
async function secureGet(alias: string): Promise<string | undefined> {
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
    console.error(`[ServerStore] secureGet(${alias}) failed: ${err}`);
    return undefined;
  }
}

async function securePut(alias: string, value: string): Promise<void> {
  let aliasBytes: Uint8Array = strToBytes(alias);
  let secretBytes: Uint8Array = strToBytes(value);
  try {
    let attrs: asset.AssetMap = new Map();
    attrs.set(asset.Tag.ALIAS, aliasBytes);
    attrs.set(asset.Tag.SECRET, secretBytes);
    attrs.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    await asset.add(attrs);
  } catch (addErr) {
    // 已存在（或冲突）→ 改走 update(query, attributes) 覆盖
    try {
      let query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, aliasBytes);
      let update: asset.AssetMap = new Map();
      update.set(asset.Tag.SECRET, secretBytes);
      await asset.update(query, update);
    } catch (updateErr) {
      console.error(`[ServerStore] securePut(${alias}) failed: ${updateErr}`);
    }
  }
}

/**
 * 服务器配置列表 + 当前选中（对齐 Dart server_store.dart）。
 * 数据模型从第一天就是多 profile，UI 先做单服务器。
 */
export class ServerStore {
  private profilesValue: ServerProfile[] = [];
  private currentIdValue: string | undefined = undefined;
  private loaded: boolean = false;
  private static instanceValue: ServerStore | undefined = undefined;

  static getInstance(): ServerStore {
    if (ServerStore.instanceValue === undefined) {
      ServerStore.instanceValue = new ServerStore();
    }
    return ServerStore.instanceValue;
  }

  /** 首次读取持久化数据（幂等；存储损坏时回退空列表，让用户重新配置而不是启动即崩）。 */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    let raw: string | undefined = await secureGet(PROFILES_ALIAS);
    let currentId: string | undefined = await secureGet(CURRENT_ID_ALIAS);
    let profiles: ServerProfile[] = [];
    if (raw !== undefined && raw.length > 0) {
      try {
        let root: Object | null = JSON.parse(raw) as Object | null;
        if (root !== null && Array.isArray(root)) {
          let items: Object[] = root as Object[];
          for (let item of items) {
            let rec: Record<string, Object> | undefined = asRecord(item);
            if (rec !== undefined) {
              profiles.push(ServerProfile.fromJson(rec));
            }
          }
        }
      } catch (err) {
        profiles = [];
        currentId = undefined;
      }
    }
    this.profilesValue = profiles;
    this.currentIdValue = currentId !== undefined && currentId.length > 0 ? currentId : undefined;
    this.loaded = true;
  }

  profiles(): ServerProfile[] {
    return this.profilesValue;
  }

  /** 当前选中的 profile：优先 currentId 匹配项，否则列表第一项；空列表返回 undefined。 */
  current(): ServerProfile | undefined {
    if (this.profilesValue.length === 0) {
      return undefined;
    }
    for (let profile of this.profilesValue) {
      if (profile.id === this.currentIdValue) {
        return profile;
      }
    }
    return this.profilesValue[0];
  }

  currentId(): string | undefined {
    return this.currentIdValue;
  }

  /** 保存（或更新）profile 并选为当前。 */
  async upsertAndSelect(profile: ServerProfile): Promise<void> {
    let next: ServerProfile[] = [];
    let replaced: boolean = false;
    for (let existing of this.profilesValue) {
      if (existing.id === profile.id) {
        next.push(profile);
        replaced = true;
      } else {
        next.push(existing);
      }
    }
    if (!replaced) {
      next.push(profile);
    }
    this.profilesValue = next;
    this.currentIdValue = profile.id;
    this.loaded = true;
    let rawList: Record<string, Object>[] = [];
    for (let item of next) {
      rawList.push(item.toJson());
    }
    await securePut(PROFILES_ALIAS, JSON.stringify(rawList));
    await securePut(CURRENT_ID_ALIAS, profile.id);
  }
}
