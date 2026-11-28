import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/services/runtime";
import ProviderExportDialog from "./ProviderExportDialog";

/** 供应商页头的「导出到手机」按钮 + 对话框。导出码只活在桌面进程里：浏览器 / 远程网页不显示（docs/112 §6）。 */
export default function ProviderExportAction({ compact }: { compact?: boolean }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  if (!isTauriRuntime()) return null;
  return (
    <>
      <Button
        variant="outline"
        size={compact ? "xs" : "sm"}
        data-testid="provider-export-open"
        onClick={() => setOpen(true)}
      >
        <Smartphone size={14} />
        {t("providerExport.exportButton")}
      </Button>
      <ProviderExportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
