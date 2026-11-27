import i18n from "@/i18n";
import { portPreviewService } from "@/services/portPreviewService";
import { usePanesStore } from "@/stores/usePanesStore";
import { usePortPreviewStore } from "@/stores/usePortPreviewStore";
import { localPreviewUrl, type LocalhostPreviewLink } from "@/lib/localhostPreviewLink";

/**
 * 「在本机预览」：为该 SSH 会话建（或复用）一条本地端口转发，再在内置浏览器标签打开。
 * 返回打开的本机地址。非 SSH 会话直接报错（本机/WSL 的 localhost 本来就能打开）。
 */
export async function openPortPreview(sessionId: string, link: LocalhostPreviewLink): Promise<string> {
  const ssh = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId)?.tab.ssh;
  if (!ssh) throw new Error(i18n.t("panes:portPreview.notSsh"));
  const tunnel = await portPreviewService.open({
    sessionId,
    ssh,
    remoteHost: link.remoteHost,
    remotePort: link.port,
  });
  const url = localPreviewUrl(link, tunnel.localPort);
  usePanesStore.getState().openBrowser(url, `${ssh.host}:${link.port}`);
  void usePortPreviewStore.getState().refresh().catch(() => undefined);
  return url;
}
