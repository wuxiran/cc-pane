// 添加设备：SSH 服务器（可立即部署）或直连另一台 CC-Panes。docs/111-multi-device.md
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedTabs } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSshMachinesStore } from "@/stores";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { getErrorMessage } from "@/utils";
import type { DeviceSummary } from "@/types/device";
import { isInsecureRemoteUrl } from "./devicesModel";

const DEFAULT_REMOTE_PORT = 18765;

interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 添加成功；`deploy` 表示用户要求立即部署 */
  onAdded: (device: DeviceSummary, deploy: boolean) => void;
}

type Kind = "ssh" | "direct";

export default function AddDeviceDialog({ open, onOpenChange, onAdded }: AddDeviceDialogProps) {
  const { t } = useTranslation("sidebar");
  const machines = useSshMachinesStore((s) => s.machines);
  const loadMachines = useSshMachinesStore((s) => s.load);
  const addDevice = useDevicesStore((s) => s.add);

  const [kind, setKind] = useState<Kind>("ssh");
  const [name, setName] = useState("");
  const [machineId, setMachineId] = useState("");
  const [remotePort, setRemotePort] = useState(String(DEFAULT_REMOTE_PORT));
  const [deployNow, setDeployNow] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind("ssh");
    setName("");
    setMachineId("");
    setRemotePort(String(DEFAULT_REMOTE_PORT));
    setDeployNow(true);
    setBaseUrl("");
    setToken("");
    loadMachines().catch(() => {});
  }, [open, loadMachines]);

  const machine = machines.find((item) => item.id === machineId);
  const port = Number(remotePort);
  const portValid = Number.isInteger(port) && port > 0 && port <= 65535;
  const urlValid = /^https?:\/\/\S+$/.test(baseUrl.trim());
  const effectiveName = name.trim() || (kind === "ssh" ? machine?.name ?? "" : "");
  const canSubmit = !saving && effectiveName.length > 0 && (kind === "ssh"
    ? Boolean(machine) && portValid
    : urlValid && token.trim().length > 0);
  const insecure = useMemo(() => kind === "direct" && isInsecureRemoteUrl(baseUrl), [kind, baseUrl]);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const device = await addDevice({
        name: effectiveName,
        connection: kind === "ssh"
          ? { kind: "ssh", machineId, remotePort: port }
          : { kind: "direct", baseUrl: baseUrl.trim() },
        token: kind === "direct" ? token.trim() : undefined,
      });
      onOpenChange(false);
      onAdded(device, kind === "ssh" && deployNow);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("devices.dialog.title")}</DialogTitle>
          <DialogDescription>
            {kind === "ssh" ? t("devices.dialog.kindSshHint") : t("devices.dialog.kindDirectHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <SegmentedTabs<Kind>
            value={kind}
            onValueChange={setKind}
            size="sm"
            items={[
              { value: "ssh", label: t("devices.dialog.kindSsh") },
              { value: "direct", label: t("devices.dialog.kindDirect") },
            ]}
          />

          {kind === "ssh" ? (
            <>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.machine")}
                {machines.length === 0 ? (
                  <span style={{ color: "var(--app-text-tertiary)" }}>{t("devices.dialog.noMachines")}</span>
                ) : (
                  <Select value={machineId} onValueChange={setMachineId}>
                    <SelectTrigger className="h-8 text-xs" data-testid="device-machine-select">
                      <SelectValue placeholder={t("devices.dialog.machine")} />
                    </SelectTrigger>
                    <SelectContent>
                      {machines.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} · {item.user ? `${item.user}@` : ""}{item.host}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.name")}
                <Input
                  className="h-8 text-xs"
                  value={name}
                  placeholder={machine?.name ?? ""}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.remotePort")}
                <Input
                  className="h-8 w-32 text-xs"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                <Checkbox checked={deployNow} onCheckedChange={(checked) => setDeployNow(checked === true)} />
                {t("devices.dialog.deployNow")}
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.name")}
                <Input className="h-8 text-xs" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.baseUrl")}
                <Input
                  className="h-8 text-xs"
                  value={baseUrl}
                  placeholder={t("devices.dialog.baseUrlPlaceholder")}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("devices.dialog.token")}
                <Input
                  className="h-8 font-mono text-xs"
                  type="password"
                  autoComplete="off"
                  value={token}
                  placeholder="ccp_dev_…"
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              {insecure && (
                <p className="text-xs" style={{ color: "var(--app-status-warning)" }}>
                  {t("devices.dialog.insecureHint")}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("devices.dialog.cancel")}
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()} data-testid="device-add-submit">
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {t("devices.dialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
