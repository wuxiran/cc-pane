// 手动更新设备令牌（直连设备，或 SSH 设备不想重新部署时）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { getErrorMessage } from "@/utils";
import type { DeviceSummary } from "@/types/device";

export default function DeviceTokenDialog({ device, onClose }: {
  device: DeviceSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const setToken = useDevicesStore((s) => s.setToken);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (device) setValue("");
  }, [device]);

  const save = async () => {
    if (!device || !value.trim()) return;
    setSaving(true);
    try {
      await setToken(device.id, value.trim());
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={device !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("devices.tokenDialog.title")}{device ? ` · ${device.name}` : ""}</DialogTitle>
          <DialogDescription>{t("devices.tokenDialog.description")}</DialogDescription>
        </DialogHeader>
        <Input
          className="h-8 font-mono text-xs"
          type="password"
          autoComplete="off"
          placeholder="ccp_dev_…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("devices.dialog.cancel")}</Button>
          <Button size="sm" disabled={saving || !value.trim()} onClick={() => void save()}>
            {t("devices.updateToken")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
