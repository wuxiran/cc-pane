// 「其他电脑」管理（docs/112 §5.1）：已配对的电脑、局域网 / Tailscale 发现、
// 用配对码互联、移除。发现只是「看见」，互联必须走一次配对。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Radar, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastErr, toastOk } from "@/lib/feedback";
import { botMeshService } from "@/services/botMeshService";
import { nativeConfirm } from "@/services/nativeDialog";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { DiscoveredNode, DiscoveryReport, MeshAddressSource, MeshPeer } from "@/types/botMesh";

interface PairDraft {
  name: string;
  baseUrl: string;
  code: string;
  source: MeshAddressSource;
}

const EMPTY_DRAFT: PairDraft = { name: "", baseUrl: "http://", code: "", source: "manual" };

export default function MeshPeersDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation("sidebar");
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState<PairDraft>(EMPTY_DRAFT);
  const [pairing, setPairing] = useState(false);

  const reload = useCallback(() => {
    botMeshService.peers().then(setPeers).catch((error) => handleErrorSilent(error, "mesh peers"));
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setReport(await botMeshService.discover());
      reload();
    } catch (error) {
      toastErr(String(error));
    } finally {
      setScanning(false);
    }
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    reload();
    void scan();
  }, [open, reload, scan]);

  const pickNode = (node: DiscoveredNode) =>
    setDraft({ name: node.name, baseUrl: node.addresses[0] ?? "http://", code: "", source: node.source });

  const pair = async () => {
    setPairing(true);
    try {
      await botMeshService.pair(draft.name, draft.baseUrl, draft.code, draft.source);
      toastOk(t("bots.mesh.paired"));
      setDraft(EMPTY_DRAFT);
      reload();
      onChanged();
    } catch (error) {
      toastErr(String(error));
    } finally {
      setPairing(false);
    }
  };

  const remove = async (peer: MeshPeer) => {
    if (!(await nativeConfirm(t("bots.mesh.removeConfirm", { name: peer.name })))) return;
    try {
      await botMeshService.removePeer(peer.deviceId);
      reload();
      onChanged();
    } catch (error) {
      toastErr(String(error));
    }
  };

  const unpaired = (report?.nodes ?? []).filter((node) => !node.pairedDeviceId);
  const muted = "text-[length:var(--text-micro)] text-[var(--app-text-muted)]";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg" data-testid="mesh-peers">
        <DialogHeader>
          <DialogTitle>{t("bots.mesh.peersTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-[length:var(--text-small)]">
          <section className="flex flex-col gap-1">
            <span className="font-medium">{t("bots.mesh.pairedPeers")}</span>
            {peers.length === 0 && <span className={muted}>{t("bots.mesh.noPeers")}</span>}
            {peers.map((peer) => (
              <div key={peer.deviceId} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--app-hover)]">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{peer.name}</span>
                  <span className={`truncate ${muted}`}>
                    {(peer.preferredUrl ?? peer.targetLabel) + (peer.lastSeenAt ? ` · ${t("bots.mesh.lastSeen", { at: new Date(peer.lastSeenAt).toLocaleString() })}` : "")}
                  </span>
                  {peer.addresses.length > 1 && (
                    <span className={`truncate ${muted}`}>
                      {peer.addresses.map((a) => `${t(`bots.mesh.source.${a.source}`)} ${a.url}`).join(" · ")}
                    </span>
                  )}
                </span>
                <button type="button" aria-label={t("bots.mesh.remove")} className="rounded p-1 text-[var(--app-icon-inactive)] hover:text-[var(--app-status-danger)]" onClick={() => void remove(peer)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-1">
            <span className="flex items-center gap-2 font-medium">
              {t("bots.mesh.discovered")}
              <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
                <Radar className="mr-1 h-3.5 w-3.5" />
                {scanning ? t("bots.mesh.scanning") : t("bots.mesh.scan")}
              </Button>
            </span>
            {report && (
              <span className={muted} data-testid="mesh-discovery-state">
                {t("bots.mesh.discoveryState", {
                  tailscale: t(`bots.mesh.tailscale.${report.tailscale}`, { defaultValue: report.tailscale }),
                  mdns: report.mdns === "ok" ? t("bots.mesh.mdnsOk") : report.mdns,
                })}
                {!report.advertising && ` · ${t("bots.mesh.notAdvertising")}`}
              </span>
            )}
            {unpaired.map((node) => (
              <button
                key={`${node.source}-${node.instanceId ?? node.name}`}
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--app-hover)]"
                onClick={() => pickNode(node)}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: node.reachable ? "var(--app-status-success)" : "var(--app-icon-inactive)" }}
                />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className={muted}>{t(`bots.mesh.source.${node.source}`)} · {node.addresses[0]}</span>
              </button>
            ))}
          </section>
          <section className="flex flex-col gap-1.5 rounded-md border border-[var(--app-border)] p-2">
            <span className="font-medium">{t("bots.mesh.pairTitle")}</span>
            <span className={muted}>{t("bots.mesh.pairHint")}</span>
            <Input aria-label={t("bots.mesh.pairName")} placeholder={t("bots.mesh.pairName")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input aria-label={t("bots.mesh.pairUrl")} placeholder="http://100.x.y.z:18080" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value, source: "manual" })} />
            <div className="flex gap-2">
              <Input aria-label={t("bots.mesh.pairCode")} placeholder={t("bots.mesh.pairCode")} inputMode="numeric" maxLength={6} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.replace(/\D/g, "") })} />
              <Button disabled={pairing || draft.code.length !== 6 || !/^https?:\/\/.+/.test(draft.baseUrl)} onClick={() => void pair()}>
                {t("bots.mesh.pair")}
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
