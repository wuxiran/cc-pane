import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getErrorMessage, handleErrorSilent } from "@/utils";
import { hasBusySessions } from "@/lib/interruptGate";
import { useUpdateStore } from "@/stores";
import { isTauriRuntime } from "./runtime";
// 直接从模块导入（不走 @/services 桶文件）避免服务间循环依赖
import { settingsService } from "./settingsService";

export interface UpdateInstallProgress {
  phase: "starting" | "downloading" | "installing";
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export async function checkForAvailableUpdate(): Promise<Update | null> {
  if (!isTauriRuntime()) return null;
  return check();
}

/**
 * 静默检查更新，结果写入 useUpdateStore（不弹窗）
 */
export async function checkUpdateSilent(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const update = await check();
    if (update) {
      useUpdateStore.getState().setUpdate(update.version, update.body ?? null);
    } else {
      useUpdateStore.getState().clearUpdate();
    }
  } catch (error) {
    // 静默检查失败不弹任何东西（弹了就不叫静默），但必须可发现：
    // 进应用日志 + 记进 store 供 设置→关于 显示。本项目 GitHub 直连已知不稳，
    // 完全吞掉的话用户得到的信号是「这软件从来不更新」。
    handleErrorSilent(error, "updater silent check");
    useUpdateStore.getState().setCheckFailure(getErrorMessage(error), new Date().toISOString());
  }
}

/**
 * 检查应用更新（用户主动触发 / 启动时静默检查）
 * @param userInitiated - true: 无更新也弹提示；false: 仅写入 store
 */
export async function checkForAppUpdates(userInitiated: boolean): Promise<void> {
  if (!isTauriRuntime()) {
    if (userInitiated) {
      console.info("[updater] Updates are only available in the desktop app");
    }
    return;
  }
  try {
    const update = await check();

    if (!update) {
      useUpdateStore.getState().clearUpdate();
      if (userInitiated) {
        await message("当前已是最新版本。", { title: "检查更新", kind: "info" });
      }
      return;
    }

    useUpdateStore.getState().setUpdate(update.version, update.body ?? null);

    // 静默检查：只设 store，不弹窗
    if (!userInitiated) return;

    // 用户主动检查 / 点击更新按钮：弹确认
    await promptAndInstallUpdate(update);
  } catch (error) {
    console.error("[updater] 检查更新失败:", error);
    if (userInitiated) {
      const msg = getErrorMessage(error);
      const hint = getUpdateErrorHint(msg);
      await message(`检查更新失败：${msg}${hint}`, { title: "检查更新", kind: "error" });
    }
  }
}

/**
 * 触发更新流程（从 StatusBar 更新按钮调用）
 * 重新 check → 弹确认 → 下载安装 → 重启
 */
export async function triggerUpdate(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const update = await check();
    if (!update) {
      useUpdateStore.getState().clearUpdate();
      await message("当前已是最新版本。", { title: "检查更新", kind: "info" });
      return;
    }
    await promptAndInstallUpdate(update);
  } catch (error) {
    console.error("[updater] 触发更新失败:", error);
    const msg = getErrorMessage(error);
    await message(`检查更新失败：${msg}${getUpdateErrorHint(msg)}`, {
      title: "检查更新",
      kind: "error",
    });
  }
}

// ---- internal ----

export function getUpdateErrorHint(message: string, language = "zh-CN"): string {
  const isChinese = language.toLowerCase().startsWith("zh");
  if (message.includes("fallback platforms") || message.includes("platforms object")) {
    return isChinese
      ? "\n\n提示：当前发布清单缺少本机平台的自动更新包，请从下载页手动获取对应平台版本，或等待补发新版。"
      : "\n\nThe release manifest does not include an automatic update for this platform. Download it manually or wait for a corrected release.";
  }

  if (
    message.includes("request") ||
    message.includes("connect") ||
    message.includes("timed out")
  ) {
    return isChinese
      ? "\n\n提示：如果无法访问 GitHub，请确认代理工具已开启「系统代理」模式，或在 设置 → 代理 中手动配置。"
      : "\n\nIf GitHub is unreachable, enable system proxy mode or configure a proxy in Settings → Proxy.";
  }

  return "";
}

async function promptAndInstallUpdate(update: Awaited<ReturnType<typeof check>>): Promise<void> {
  if (!update) return;

  // 安装会停掉 daemon 并重启应用，在跑的 agent 会话会被中断。更新卡片路径有自己的
  // busyAtConfirmation 警告；状态栏 / 首页 / 关于页三个入口都汇流到这里，警告必须在
  // 这条共享路径上，否则从那三处点更新就是无声杀会话。
  const busyWarning = hasBusySessions()
    ? "\n\n⚠ 当前有会话正在运行，安装会中断它们。"
    : "";
  const confirmed = await ask(
    `发现新版本 ${update.version}，是否立即下载并安装？${busyWarning}\n\n${update.body ?? ""}`,
    { title: "发现新版本", kind: "info", okLabel: "立即更新", cancelLabel: "稍后" },
  );

  if (!confirmed) return;

  await downloadAndInstallUpdate(update);
}

/** 下载并安装指定更新；卡片和原生确认路径共享同一套真实进度与重启流程。 */
export async function downloadAndInstallUpdate(
  update: Update,
  onProgress?: (progress: UpdateInstallProgress) => void,
): Promise<void> {
  // 安装前先停掉 cc-panes-web + cc-panes-daemon（释放它们对 binaries 下二进制的
  // 文件锁）：否则 Windows NSIS 安装程序无法替换正在运行的
  // binaries/cc-panes-web.exe / cc-panes-daemon.exe，会静默失败并留下旧二进制
  // （表现为"更新后 web 仍是旧版读不出工作空间 / daemon 侧修复不生效"）。
  // 停 daemon 会中断托管的活会话，但更新即将重启应用，可接受。任一停止失败不阻断更新。
  try {
    await settingsService.stopWebAccess();
  } catch (error) {
    console.warn("[updater] 安装前停止 Web 服务失败（继续更新）:", error);
  }
  try {
    await settingsService.stopTerminalDaemon();
  } catch (error) {
    console.warn("[updater] 安装前停止终端 daemon 失败（继续更新）:", error);
  }

  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  const reportProgress = (progress: DownloadEvent) => {
    if (progress.event === "Started") {
      totalBytes = progress.data.contentLength ?? null;
      console.debug(`[updater] 开始下载，大小: ${totalBytes ?? "unknown"} bytes`);
      onProgress?.({
        phase: "starting",
        downloadedBytes,
        totalBytes,
        percent: totalBytes === null ? null : 0,
      });
    } else if (progress.event === "Progress") {
      downloadedBytes += progress.data.chunkLength;
      console.debug(`[updater] 已下载: ${progress.data.chunkLength} bytes`);
      onProgress?.({
        phase: "downloading",
        downloadedBytes,
        totalBytes,
        percent: totalBytes === null ? null : Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)),
      });
    } else if (progress.event === "Finished") {
      console.debug("[updater] 下载完成");
      onProgress?.({
        phase: "installing",
        downloadedBytes,
        totalBytes,
        percent: 100,
      });
    }
  };

  await update.downloadAndInstall(reportProgress);

  // Windows NSIS passive 模式：安装后应用会自动退出并运行安装程序
  // 其他平台需要手动重启
  await relaunch();
}
