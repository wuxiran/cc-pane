// 一条发往 Bot（本机或其他电脑）的消息：正文、状态、回复、待审批按钮。
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastErr } from "@/lib/feedback";
import { botMeshService } from "@/services/botMeshService";
import type { OutboxEntry, PendingPermission } from "@/types/botMesh";

function optionsOf(permission: PendingPermission) {
  return permission.params.options ?? [];
}

export default function MeshMessageCard({ entry }: { entry: OutboxEntry }) {
  const { t } = useTranslation("sidebar");
  const answer = (permission: PendingPermission, optionId: string | null) =>
    botMeshService
      .respondPermission(entry.deviceId, entry.botId, permission.requestKey, optionId)
      .catch((error) => toastErr(String(error)));

  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--app-border)] p-2" data-testid="mesh-message">
      <div className="self-end whitespace-pre-wrap rounded-md bg-[var(--app-hover)] px-2 py-1">{entry.text}</div>
      <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]" data-testid="mesh-message-status">
        {t(`bots.mesh.status.${entry.status}`)}
        {entry.hops > 0 && ` · ${t("bots.mesh.hops", { hops: entry.hops })}`}
      </span>
      {entry.pendingPermissions.map((permission) => (
        <div
          key={permission.requestKey}
          className="flex flex-col gap-1 rounded-md border px-2 py-1"
          style={{ borderColor: "var(--app-status-warning)" }}
        >
          <span className="text-[length:var(--text-micro)]">
            {t("bots.mesh.needsApproval", {
              title: permission.params.toolCall?.title ?? permission.params.toolCall?.kind ?? "",
            })}
          </span>
          <div className="flex flex-wrap gap-1">
            {optionsOf(permission).map((option) => (
              <Button
                key={option.optionId}
                size="sm"
                variant={option.kind?.startsWith("allow") ? "default" : "outline"}
                onClick={() => void answer(permission, option.optionId)}
              >
                {option.name ?? option.optionId}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => void answer(permission, null)}>
              {t("bots.cancel")}
            </Button>
          </div>
        </div>
      ))}
      {entry.reply && <div className="whitespace-pre-wrap" data-testid="mesh-message-reply">{entry.reply}</div>}
      {entry.error && (
        <span className="text-[length:var(--text-micro)] text-[var(--app-status-danger)]">
          {entry.error.code}: {entry.error.message}
        </span>
      )}
    </div>
  );
}
