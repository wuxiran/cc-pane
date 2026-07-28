import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriRuntime } from "@/services/runtime";
import { handleErrorSilent } from "@/utils";

/**
 * tip 的落点教程链接。
 *
 * 仓库里没有「内置 Markdown 预览打开本地 docs」这条路——`docs/guide/*.md`
 * 是仓库内文件，安装版机器上根本不存在。全仓库唯一既有的"打开外部资源"惯例是
 * `UpdateNotification.tsx` 的 `openUrl` + `window.open` 兜底，这里沿用它，
 * 指向 GitHub 上的 guide 正文。
 */
const GUIDE_BASE_URL = "https://github.com/wuxiran/cc-pane/blob/main/";

export function guideDocUrl(guidePath: string): string {
  return `${GUIDE_BASE_URL}${guidePath}`;
}

export async function openGuideDoc(guidePath: string): Promise<void> {
  const url = guideDocUrl(guidePath);
  try {
    if (isTauriRuntime()) {
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch (reason) {
    handleErrorSilent(reason, "open feature tip guide");
  }
}
