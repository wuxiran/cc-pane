import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getErrorMessage } from "@/utils";
import { useUpdateStore } from "@/stores";
import { isTauriRuntime } from "./runtime";
// 直接从模块导入（不走 @/services 桶文件）避免服务间循环依赖
import { settingsService } from "./settingsService";

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
    console.error("[updater] 静默检查更新失败:", error);
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

function getUpdateErrorHint(message: string): string {
  if (message.includes("fallback platforms") || message.includes("platforms object")) {
    return "\n\n提示：当前发布清单缺少本机平台的自动更新包，请从 GitHub Release 手动下载对应平台版本，或等待补发新版。";
  }

  if (
    message.includes("request") ||
    message.includes("connect") ||
    message.includes("timed out")
  ) {
    return "\n\n提示：如果无法访问 GitHub，请确认代理工具已开启「系统代理」模式，或在 设置 → 代理 中手动配置。";
  }

  return "";
}

async function promptAndInstallUpdate(update: Awaited<ReturnType<typeof check>>): Promise<void> {
  if (!update) return;

  const confirmed = await ask(
    `发现新版本 ${update.version}，是否立即下载并安装？\n\n${update.body ?? ""}`,
    { title: "发现新版本", kind: "info", okLabel: "立即更新", cancelLabel: "稍后" },
  );

  if (!confirmed) return;

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

  await update.downloadAndInstall((progress) => {
    if (progress.event === "Started" && progress.data.contentLength) {
      console.debug(`[updater] 开始下载，大小: ${progress.data.contentLength} bytes`);
    } else if (progress.event === "Progress") {
      console.debug(`[updater] 已下载: ${progress.data.chunkLength} bytes`);
    } else if (progress.event === "Finished") {
      console.debug("[updater] 下载完成");
    }
  });

  // Windows NSIS passive 模式：安装后应用会自动退出并运行安装程序
  // 其他平台需要手动重启
  await relaunch();
}
