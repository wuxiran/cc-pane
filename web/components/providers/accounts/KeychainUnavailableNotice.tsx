import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { providerService } from "@/services/providerService";
import { handleErrorSilent } from "@/utils";

/** 没有系统钥匙串的环境（如部分 Linux / 容器）：密钥以文件存在 providers.json，在供应商列表上方说明。 */
export default function KeychainUnavailableNotice() {
  const { t } = useTranslation("providers");
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    providerService.getSecretStatus()
      .then((status) => { if (!cancelled) setAvailable(status.keychainAvailable); })
      .catch((error) => handleErrorSilent(error, "provider secret status"));
    return () => { cancelled = true; };
  }, []);

  if (available) return null;
  return (
    <div
      role="note"
      className="mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{ borderColor: "var(--app-status-warning)", color: "var(--app-text-secondary)" }}
    >
      <KeyRound size={13} className="mt-0.5 shrink-0" style={{ color: "var(--app-status-warning)" }} />
      <span>{t("providerAccounts.keychainUnavailable")}</span>
    </div>
  );
}
