import { AppConfig } from '../common/Config';
import { pathBasename } from '../common/Format';
import { SessionInfo } from './SessionInfo';
import { SavedSession } from './SavedSession';
import {
  collectSessionCards,
  LayoutSnapshot,
  normalizeProjectPath,
  SessionCard
} from './LayoutSnapshot';

export enum MirrorGroupKind {
  Layout = 'layout',
  MobileRemote = 'mobileRemote',
  Orphan = 'orphan',
}

/** 一张镜像卡：一个活会话 = 布局里的一个终端 leaf / 手机远程会话 / 孤儿会话。 */
export class MirrorCard {
  readonly sessionId: string;
  readonly title: string;
  readonly info: SessionInfo;
  readonly projectName: string | undefined;
  readonly cliTool: string | undefined;
  readonly paneOrdinal: number | undefined;
  readonly isActiveLeaf: boolean;
  readonly orphanReason: string | undefined;

  constructor(
    sessionId: string,
    title: string,
    info: SessionInfo,
    projectName: string | undefined,
    cliTool: string | undefined,
    paneOrdinal: number | undefined,
    isActiveLeaf: boolean,
    orphanReason: string | undefined
  ) {
    this.sessionId = sessionId;
    this.title = title;
    this.info = info;
    this.projectName = projectName;
    this.cliTool = cliTool;
    this.paneOrdinal = paneOrdinal;
    this.isActiveLeaf = isActiveLeaf;
    this.orphanReason = orphanReason;
  }
}

export class MirrorGroup {
  readonly kind: MirrorGroupKind;
  readonly title: string;
  readonly cards: MirrorCard[];
  readonly layoutId: string | undefined;
  readonly isCurrentLayout: boolean;

  constructor(
    kind: MirrorGroupKind,
    title: string,
    cards: MirrorCard[],
    layoutId: string | undefined,
    isCurrentLayout: boolean
  ) {
    this.kind = kind;
    this.title = title;
    this.cards = cards;
    this.layoutId = layoutId;
    this.isCurrentLayout = isCurrentLayout;
  }
}

/** 镜像视图：分组的会话卡 + 陈旧标记 + 元信息。 */
export class MirrorState {
  readonly groups: MirrorGroup[];

  /** 电脑布局里有活会话的项目路径（规范化）——用于工作区 tab 标「电脑在跑」。 */
  readonly desktopProjectPaths: Set<string>;

  /** 手机自己 launch 的项目路径（规范化）——用于工作区 tab 标「手机打开」。 */
  readonly mobileProjectPaths: Set<string>;

  /** 桌面前端是否落过快照（false = 电脑未运行/未开前端）。 */
  readonly snapshotAvailable: boolean;

  /** 快照过旧（savedAt 超阈值）——数据可能不反映电脑当前状态。 */
  readonly stale: boolean;
  readonly savedAtMs: number | undefined;
  readonly workspaceName: string | undefined;

  constructor(
    groups: MirrorGroup[],
    snapshotAvailable: boolean,
    stale: boolean,
    savedAtMs: number | undefined,
    workspaceName: string | undefined,
    desktopProjectPaths: Set<string>,
    mobileProjectPaths: Set<string>
  ) {
    this.groups = groups;
    this.snapshotAvailable = snapshotAvailable;
    this.stale = stale;
    this.savedAtMs = savedAtMs;
    this.workspaceName = workspaceName;
    this.desktopProjectPaths = desktopProjectPaths;
    this.mobileProjectPaths = mobileProjectPaths;
  }

  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  static empty(): MirrorState {
    return new MirrorState([], false, false, undefined, undefined, new Set<string>(), new Set<string>());
  }
}

class LayoutMetaEntry {
  name: string;
  current: boolean;

  constructor(name: string, current: boolean) {
    this.name = name;
    this.current = current;
  }
}

/**
 * 合成镜像状态（纯函数，语义对齐 Dart mirror_controller.buildMirrorState，有单测锁定）。
 *
 * - 布局组：collectSessionCards join /api/sessions 活会话；当前布局优先（其余保持插入顺序）。
 * - 手机远程会话组：localMeta 记录的手机 launch 会话（在 /api/sessions、不在布局）。
 * - 未归入布局组（孤儿）：/api/sessions 有、不在布局、不在 localMeta，过滤 exited/过旧。
 */
export function buildMirrorState(
  snapshot: LayoutSnapshot | undefined,
  running: SessionInfo[],
  localMeta: Map<string, SavedSession>,
  nowMs: number
): MirrorState {
  let runningById: Map<string, SessionInfo> = new Map();
  for (let s of running) {
    runningById.set(s.sessionId, s);
  }
  let cards: SessionCard[] = snapshot !== undefined ? collectSessionCards(snapshot) : [];
  let inLayout: Set<string> = new Set();
  let desktopProjectPaths: Set<string> = new Set();
  let mobileProjectPaths: Set<string> = new Set();

  // 按布局分组，保留 collectSessionCards 的顺序
  let layoutOrder: string[] = [];
  let byLayout: Map<string, MirrorCard[]> = new Map();
  let layoutMeta: Map<string, LayoutMetaEntry> = new Map();
  for (let card of cards) {
    let info: SessionInfo | undefined = runningById.get(card.sessionId);
    if (info === undefined) {
      continue; // 快照有但已不在活会话（刚关闭）→ 跳过
    }
    inLayout.add(card.sessionId);
    if (card.projectPath.length > 0) {
      desktopProjectPaths.add(normalizeProjectPath(card.projectPath));
    }
    let bucket: MirrorCard[] | undefined = byLayout.get(card.layoutId);
    if (bucket === undefined) {
      bucket = [];
      byLayout.set(card.layoutId, bucket);
      layoutOrder.push(card.layoutId);
      layoutMeta.set(card.layoutId, new LayoutMetaEntry(card.layoutName, card.isCurrentLayout));
    }
    bucket.push(new MirrorCard(
      card.sessionId,
      card.title,
      info,
      card.projectName,
      card.cliTool,
      card.paneOrdinal,
      card.isActiveLeaf,
      undefined
    ));
  }

  // 当前布局提前，其余保持插入顺序（等价 Dart 的 sort(current first)，但稳定）
  let orderedIds: string[] = [];
  for (let id of layoutOrder) {
    let meta: LayoutMetaEntry | undefined = layoutMeta.get(id);
    if (meta !== undefined && meta.current) {
      orderedIds.push(id);
    }
  }
  for (let id of layoutOrder) {
    let meta: LayoutMetaEntry | undefined = layoutMeta.get(id);
    if (meta === undefined || !meta.current) {
      orderedIds.push(id);
    }
  }

  let groups: MirrorGroup[] = [];
  for (let id of orderedIds) {
    let meta: LayoutMetaEntry | undefined = layoutMeta.get(id);
    let bucket: MirrorCard[] | undefined = byLayout.get(id);
    if (meta === undefined || bucket === undefined) {
      continue;
    }
    groups.push(new MirrorGroup(MirrorGroupKind.Layout, meta.name, bucket, id, meta.current));
  }

  // 孤儿 + 手机远程
  let mobileCards: MirrorCard[] = [];
  let orphanCards: MirrorCard[] = [];
  for (let info of running) {
    if (inLayout.has(info.sessionId)) {
      continue;
    }
    let meta: SavedSession | undefined = localMeta.get(info.sessionId);
    if (meta !== undefined) {
      if (meta.projectPath.length > 0) {
        mobileProjectPaths.add(normalizeProjectPath(meta.projectPath));
      }
      mobileCards.push(new MirrorCard(
        info.sessionId,
        meta.displayTitle,
        info,
        pathBasename(meta.projectPath),
        meta.cliTool,
        undefined,
        false,
        undefined
      ));
      continue;
    }
    // 非手机启动的孤儿：过滤已退出 / 过旧（陈旧缺失、僵尸残留）
    if (info.exited) {
      continue;
    }
    let age: number = nowMs - info.updatedAt;
    if (age > AppConfig.ORPHAN_STALE_MS) {
      continue;
    }
    orphanCards.push(new MirrorCard(
      info.sessionId,
      info.sessionId,
      info,
      undefined,
      undefined,
      undefined,
      false,
      '未在电脑布局中'
    ));
  }
  if (mobileCards.length > 0) {
    groups.push(new MirrorGroup(MirrorGroupKind.MobileRemote, '手机远程会话', mobileCards, undefined, false));
  }
  if (orphanCards.length > 0) {
    groups.push(new MirrorGroup(MirrorGroupKind.Orphan, '未归入布局', orphanCards, undefined, false));
  }

  let savedAtMs: number | undefined = snapshot !== undefined ? snapshot.savedAtMs() : undefined;
  let stale: boolean = savedAtMs !== undefined && (nowMs - savedAtMs) > AppConfig.SNAPSHOT_STALE_MS;

  return new MirrorState(
    groups,
    snapshot !== undefined,
    stale,
    savedAtMs,
    snapshot !== undefined ? snapshot.workspaceName : undefined,
    desktopProjectPaths,
    mobileProjectPaths
  );
}
