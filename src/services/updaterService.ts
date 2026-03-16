import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getErrorMessage } from "@/utils";
import { useUpdateStore } from "@/stores";

/**
 * 静默检查更新，结果写入 useUpdateStore（不弹窗）
 */
export async function checkUpdateSilent(): Promise<void> {
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
      await message(`检查更新失败：${getErrorMessage(error)}`, { title: "检查更新", kind: "error" });
    }
  }
}

/**
 * 触发更新流程（从 StatusBar 更新按钮调用）
 * 重新 check → 弹确认 → 下载安装 → 重启
 */
export async function triggerUpdate(): Promise<void> {
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
    await message(`检查更新失败：${getErrorMessage(error)}`, { title: "检查更新", kind: "error" });
  }
}

// ---- internal ----

async function promptAndInstallUpdate(update: Awaited<ReturnType<typeof check>>): Promise<void> {
  if (!update) return;

  const confirmed = await ask(
    `发现新版本 ${update.version}，是否立即下载并安装？\n\n${update.body ?? ""}`,
    { title: "发现新版本", kind: "info", okLabel: "立即更新", cancelLabel: "稍后" },
  );

  if (!confirmed) return;

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
