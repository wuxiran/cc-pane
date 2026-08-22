// 跨终端共享字形图集（CharAtlas）的重绘协调。
//
// xterm 让**同配置**的终端共用同一张字形图集。当某个 pane 因输出新字形导致图集
// 扩容 / 加页 / 合并页时，共享纹理里字形的位置会变，但**每个 pane 各自保存 WebGL
// 顶点模型**；没有同步重建模型的 pane 会采样到错误位置 —— 表现为「大片黑 + 稀疏
// 彩色碎片」，连纯 ASCII 都会坏，点击/滚动触发全量刷新才恢复。
//
// 所以任一 pane 的图集结构变化时，必须让**所有活跃 WebGL 终端**各补一次 refresh。
// 中文尤其容易触发：每个新汉字都是一个新字形，图集重排非常频繁。
import type { Terminal } from "@xterm/xterm";

const atlasRefreshRegistry = new Set<() => void>();
let atlasRefreshScheduled = false;

/** 图集结构变化：用 rAF 合并，避免每个事件都全量重画所有 pane。 */
export function notifyAtlasStructureChanged(): void {
  if (atlasRefreshScheduled) return;
  atlasRefreshScheduled = true;
  requestAnimationFrame(() => {
    atlasRefreshScheduled = false;
    for (const refresh of atlasRefreshRegistry) {
      try {
        refresh();
      } catch {
        // 单个 pane 刷新失败不影响其它 pane。
      }
    }
  });
}

export interface AtlasRefreshCoordinator {
  /** WebGL 启用：登记进广播名单并开始盯可见性。 */
  attach: () => void;
  /** WebGL 卸载：退出名单、停止监听，并丢弃待刷标记（重建后是全新模型）。 */
  detach: () => void;
  /** 尚未补上的重绘次数；>0 说明存在花屏风险窗口。 */
  deferredCount: () => number;
}

export interface AtlasRefreshCoordinatorOptions {
  term: Terminal;
  /** WebGL 仍活跃且控制器未销毁时为 true。 */
  isLive: () => boolean;
  /**
   * 真正执行重绘；由控制器提供，便于它记录 lastError。
   *
   * **返回是否真的画成了。** 返回 false（例如 GL context 已死但 addon 还没收到
   * context-loss 事件）时待刷标记会被保留，等下一次可见/渲染时机再试——重绘失败还把
   * 标记清掉，等于把这次补刷永久丢了。
   */
  refresh: () => boolean;
}

/**
 * 每个终端一个协调器。
 *
 * 关键在于**广播是持久的，不是发一次就算数**：图集重排发生时，隐藏的 tab / 非活动
 * 布局里的 pane 画不出来（WKWebView 会暂停不可见内容的 rAF，`term.refresh` 落到
 * 隐藏元素上也是空转）。丢弃这次刷新且不补偿，等用户切回去，那个 pane 仍用着失效
 * 的字形坐标 —— 这正是花屏。所以画不出来时保留待刷标记，等真正可见了再补。
 */
export function createAtlasRefreshCoordinator({
  term,
  isLive,
  refresh,
}: AtlasRefreshCoordinatorOptions): AtlasRefreshCoordinator {
  let pending = false;
  let deferred = 0;
  let watchers: Array<() => void> = [];

  // 只在**有正面证据**表明画不出来时才推迟；拿不到判据就照旧立刻刷。
  // 反过来写（默认不可见）会在没有布局引擎的环境里把每次刷新都挂起，
  // 而 `offsetParent === null` 对 position:fixed 元素同样成立，不能当隐藏判据。
  const isDefinitelyHidden = (): boolean => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
    const element = term.element;
    if (!element) return false;
    if (!element.isConnected) return true;
    // checkVisibility 会把祖先 display:none / visibility:hidden 一并算进去，
    // 正是隐藏 tab 与非活动布局的形态；老引擎上没有此 API 就维持原行为。
    if (typeof element.checkVisibility === "function") return !element.checkVisibility();
    return false;
  };

  const drain = () => {
    if (!pending || !isLive() || isDefinitelyHidden()) return;
    // 先画再清标记：画失败就留着，等下一次时机重试。
    if (refresh()) pending = false;
  };

  const onBroadcast = () => {
    if (!isLive()) return;
    pending = true;
    deferred += 1;
    drain();
    // 仍挂着说明这次确实被推迟了，留给可见性回调去补。
    if (!pending) deferred -= 1;
  };

  return {
    attach: () => {
      atlasRefreshRegistry.add(onBroadcast);
      if (watchers.length > 0 || typeof document === "undefined") return;

      // 「变可见」的两个来源：窗口整体从后台回来，以及本终端所在的 tab/布局重新
      // 显示。两者都只用来补刷被推迟的重绘，常态下开销可忽略。
      const onVisibilityChange = () => drain();
      document.addEventListener("visibilitychange", onVisibilityChange);
      watchers.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

      const element = term.element;
      if (element && typeof IntersectionObserver !== "undefined") {
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) drain();
        });
        observer.observe(element);
        watchers.push(() => observer.disconnect());
      }

      // 第三个时机：xterm 自己画了一帧。
      //
      // 前两个都可能漏：`display:none` 的元素交叉比恒为 0，若它恢复显示时正好还在
      // 视口外（比例仍是 0），IntersectionObserver **不会**回调——没有跨越阈值。
      // 而只要 xterm 画得出一帧，就说明它此刻确实可见，正是补刷的时机。
      //
      // 回调很热，但 `drain` 首行就是 `!pending` 早退，常态零成本；补刷本身会把
      // 标记清掉，所以不会因为 refresh 触发 onRender 而自激。
      const renderWatcher = term.onRender(() => drain());
      watchers.push(() => renderWatcher.dispose());
    },
    detach: () => {
      atlasRefreshRegistry.delete(onBroadcast);
      for (const stop of watchers) {
        try {
          stop();
        } catch {
          // 清理失败不应挡住渲染器回收。
        }
      }
      watchers = [];
      pending = false;
    },
    deferredCount: () => deferred,
  };
}
