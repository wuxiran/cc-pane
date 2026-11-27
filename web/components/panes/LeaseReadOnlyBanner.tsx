// 终端「只读：写权限由另一个实例持有」横幅 + 「抢回写权限」按钮。
// 横幅本身不拦截指针（下面的终端仍可选中/滚动），只有按钮接收点击。
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { requestLeaseReclaim } from "@/hooks/leaseReclaim";

interface LeaseReadOnlyBannerProps {
  sessionId: string;
}

export default function LeaseReadOnlyBanner({ sessionId }: LeaseReadOnlyBannerProps) {
  const { t } = useTranslation("panes");
  return (
    <div
      data-testid="terminal-lease-readonly-banner"
      className="pointer-events-none absolute left-3 top-3 z-[2] flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded px-2.5 py-1.5 text-xs"
      style={{
        top: "calc(var(--notch-bar-height, 0px) + 12px)",
        color: "var(--app-status-warning)",
        background: "var(--app-status-warning-bg)",
        border: "1px solid var(--app-status-warning)",
      }}
    >
      <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{t("terminalLeaseReadOnly")}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="terminal-lease-reclaim-button"
        className="pointer-events-auto shrink-0"
        onClick={() => requestLeaseReclaim(sessionId)}
      >
        {t("leaseReclaim.action")}
      </Button>
    </div>
  );
}
