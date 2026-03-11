import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getErrorMessage } from "@/utils";

/**
 * 检查应用更新
 * @param userInitiated - 是否由用户手动触发（true 时无更新也弹提示）
 */
export async function checkForAppUpdates(userInitiated: boolean): Promise<void> {
  try {
    const update = await check();

    if (!update) {
      if (userInitiated) {
        await message("当前已是最新版本。", { title: "检查更新", kind: "info" });
      }
      return;
    }

    const confirmed = await ask(
      `发现新版本 ${update.version}，是否立即下载并安装？\n\n${update.body ?? ""}`,
      { title: "发现新版本", kind: "info", okLabel: "立即更新", cancelLabel: "稍后" }
    );

    if (!confirmed) return;

    await update.downloadAndInstall((progress) => {
      if (progress.event === "Started" && progress.data.contentLength) {
        console.log(`[updater] 开始下载，大小: ${progress.data.contentLength} bytes`);
      } else if (progress.event === "Progress") {
        console.log(`[updater] 已下载: ${progress.data.chunkLength} bytes`);
      } else if (progress.event === "Finished") {
        console.log("[updater] 下载完成");
      }
    });

    // Windows NSIS passive 模式：安装后应用会自动退出并运行安装程序
    // 其他平台需要手动重启
    await relaunch();
  } catch (error) {
    console.error("[updater] 检查更新失败:", error);
    if (userInitiated) {
      await message(`检查更新失败：${getErrorMessage(error)}`, { title: "检查更新", kind: "error" });
    }
  }
}
