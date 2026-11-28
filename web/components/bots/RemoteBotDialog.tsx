// 给其他电脑上的 Bot 发消息（docs/112 §5.5）：消息经本机转给那台电脑，回复与
// 待审批由后端跟踪后推回来（`bot-mesh-outbox-changed`）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toastErr } from "@/lib/feedback";
import { botMeshService } from "@/services/botMeshService";
import type { OutboxEntry, SharedBot } from "@/types/botMesh";
import BotAvatar from "./BotAvatar";
import MeshMessageCard from "./MeshMessageCard";

export interface RemoteBotTarget {
  deviceId: string;
  deviceName: string;
  bot: SharedBot;
}

interface RemoteBotDialogProps {
  target: RemoteBotTarget | null;
  outbox: OutboxEntry[];
  onClose: () => void;
  onSent: (entry: OutboxEntry) => void;
}

export default function RemoteBotDialog({ target, outbox, onClose, onSent }: RemoteBotDialogProps) {
  const { t } = useTranslation("sidebar");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  if (!target) return null;
  const thread = outbox
    .filter((entry) => entry.deviceId === target.deviceId && entry.botId === target.bot.id)
    .slice()
    .reverse();

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      onSent(await botMeshService.send(target.deviceId, target.bot.id, body));
      setText("");
    } catch (error) {
      toastErr(String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="remote-bot-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotAvatar bot={target.bot} size={24} />
            {target.bot.name}
            <span className="text-[length:var(--text-micro)] font-normal text-[var(--app-text-muted)]">@ {target.deviceName}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto text-[length:var(--text-small)]">
          {thread.length === 0 && (
            <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
              {t("bots.mesh.remoteHint", { policy: t(`bots.mesh.level.${target.bot.remotePolicy}`) })}
            </span>
          )}
          {thread.map((entry) => (
            <MeshMessageCard key={entry.id} entry={entry} />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("bots.mesh.message")}
            className="min-h-[72px] rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-[length:var(--text-small)]"
            value={text}
            placeholder={t("bots.mesh.messagePlaceholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
            }}
          />
          <Button className="self-end" disabled={sending || !text.trim()} onClick={() => void send()}>
            {t("bots.mesh.send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
