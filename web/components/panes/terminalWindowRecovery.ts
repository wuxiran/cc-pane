import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";

const HEARTBEAT_INTERVAL_MS = 30_000;
const SLEEP_GAP_MS = 75_000;

interface TerminalWindowRecoveryOptions {
  isRenderVisible: () => boolean;
  getLayoutScheduler: () => TerminalLayoutScheduler | null;
  repaint: (reason: string) => void;
  getLastDevicePixelRatio: () => number;
  shouldRunWebglRecovery: () => boolean;
  scheduleWebglRecovery: (reason: string, options?: { forceRecreate?: boolean }) => void;
}

function bindHeartbeat(
  isVisible: () => boolean,
  recoverLayout: (reason: string) => void,
  { shouldRunWebglRecovery, scheduleWebglRecovery, repaint }: TerminalWindowRecoveryOptions,
): () => void {
  let lastHeartbeatAt = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastHeartbeatAt;
    lastHeartbeatAt = now;
    if (!isVisible()) return;
    if (elapsed > SLEEP_GAP_MS) {
      recoverLayout("heartbeat.resume-gap");
      if (shouldRunWebglRecovery()) {
        scheduleWebglRecovery("heartbeat.resume-gap", { forceRecreate: true });
      }
    } else if (shouldRunWebglRecovery()) {
      // 普通心跳只 repaint，不反复清共享图集或重建 WebGL context。
      repaint("webgl.heartbeat");
    }
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(heartbeat);
}

/** 窗口恢复要同时修复几何与画面；DOM/透明壁纸终端也需要，不能受 WebGL 门槛限制。 */
export function bindTerminalWindowRecovery(options: TerminalWindowRecoveryOptions): () => void {
  const {
    isRenderVisible, getLayoutScheduler, repaint, getLastDevicePixelRatio, scheduleWebglRecovery,
  } = options;
  const isVisible = () => document.visibilityState === "visible" && isRenderVisible();
  const recoverLayout = (reason: string) => {
    if (!isVisible()) return;
    // 双 RAF 等窗口恢复后的布局落地，再 fit + repaint；即使本地 cols/rows
    // 没变，也重发 PTY 尺寸，修复后台期间丢失/被其他视图覆盖的 resize。
    // 可见但未聚焦的分屏同样恢复；镜像的后端权限由 scheduler 统一守卫。
    getLayoutScheduler()?.schedule(reason, {
      force: true,
      forceBackendSync: true,
      allowInactive: true,
    });
  };
  const recoverForeground = (reason: string) => {
    recoverLayout(reason);
    if (isVisible() && window.devicePixelRatio !== getLastDevicePixelRatio()) {
      scheduleWebglRecovery(`${reason}.dpr-change`);
    }
  };
  const handleResize = () => {
    if (!isVisible()) return;
    getLayoutScheduler()?.schedule("window.resize", { allowInactive: true });
    repaint("window.resize");
  };
  const handleFocus = () => recoverForeground("window.focus");
  const handleVisibility = () => recoverForeground("document.visible");

  const disposeHeartbeat = bindHeartbeat(isVisible, recoverLayout, options);

  window.addEventListener("resize", handleResize);
  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibility);
  return () => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener("visibilitychange", handleVisibility);
    disposeHeartbeat();
  };
}
