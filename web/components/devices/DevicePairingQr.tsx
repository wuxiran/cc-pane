// 配对二维码：手机相机扫码直接打开本机 Web 客户端（本地生成 SVG，不请求任何远程服务）。
// 现有客户端（Web 登录页 / cc-panes-mobile）都不认带配对码的 URL 或 deep link，
// 所以只编码局域网 Web 地址；配对码与倒计时由面板在二维码旁边显示，Web 密码绝不进码。
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { SettingsHint } from "@/components/settings/layout";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLoopbackAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
  } catch {
    return true;
  }
}

/** 取地址列表里第一个非回环地址作为二维码内容；没有则返回 null。 */
export function pairingQrPayload(addresses: readonly string[]): string | null {
  return addresses.find((address) => !isLoopbackAddress(address)) ?? null;
}

export default function DevicePairingQr({ addresses }: { addresses: readonly string[] }) {
  const { t } = useTranslation("sidebar");
  const payload = pairingQrPayload(addresses);
  if (!payload) {
    return (
      <div data-testid="device-pairing-qr-hint">
        <SettingsHint>{t("devices.access.qrNeedsNetwork")}</SettingsHint>
      </div>
    );
  }
  return (
    <figure className="flex shrink-0 flex-col items-center gap-1" data-testid="device-pairing-qr" data-payload={payload}>
      {/* 深色模块 + 浅色静区：暗色主题下也保持可扫 */}
      <div className="rounded-md bg-white p-2">
        <QRCodeSVG value={payload} size={120} level="M" bgColor="#ffffff" fgColor="#000000" />
      </div>
      <figcaption className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
        {t("devices.access.qrCaption")}
      </figcaption>
    </figure>
  );
}
