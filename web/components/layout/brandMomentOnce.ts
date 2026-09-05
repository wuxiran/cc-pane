// 冷启动品牌瞬间的一次性闸门。
//
// 语义：每个应用会话只在 AppShell 首次挂载时播放一次品牌瞬间；
// 不随视图切换 / 主题切换 / HMR 重挂载重播。
//
// 双闸门：
//   - 模块级 flag：同一 JS 上下文内只认第一次（StrictMode 双渲染见下）；
//   - sessionStorage：Vite HMR 重载模块后仍记得已播过，dev 不烦人；
//     应用真正冷启动（新 WebView 会话）时 sessionStorage 为空 → 播放。
//
// 判定（shouldPlayBrandMoment）与标记（markBrandMomentPlayed）刻意分离：
// StrictMode 在 commit 前会双调用 render/useState 初始化器，期间两次判定必须
// 一致返回 true；标记只在挂载提交后的 effect 里落，避免「第一次渲染就消费掉
// 唯一一次机会」。

const STORAGE_KEY = "cc-panes:brand-moment-played";

/** 与 brandMoment.css 时序对齐：最后一区 320ms delay + 240ms 时长 = 560ms，+80ms 余量。 */
export const BRAND_MOMENT_TOTAL_MS = 640;

let playedThisModuleLoad = false;

/**
 * 本会话是否还应播放品牌瞬间（只读判定，不产生副作用）。
 * 挂载提交后必须调用 markBrandMomentPlayed() 落标记。
 */
export function shouldPlayBrandMoment(): boolean {
  if (playedThisModuleLoad) return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === null;
  } catch {
    // sessionStorage 不可用（罕见隐私模式）：仅靠模块级 flag，保证单上下文内一次。
    return true;
  }
}

/** 落「已播放」标记：模块级 + sessionStorage 双写。 */
export function markBrandMomentPlayed(): void {
  playedThisModuleLoad = true;
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 忽略：sessionStorage 不可用时模块级 flag 已兜底。
  }
}
