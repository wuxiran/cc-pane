// 联系人里的一台其他电脑：在线点 + 它共享的 Bot。
import { useTranslation } from "react-i18next";
import type { ContactGroup, SharedBot } from "@/types/botMesh";
import { botIsLive } from "@/types/botMesh";
import BotAvatar from "./BotAvatar";

interface RemoteDeviceGroupProps {
  group: ContactGroup;
  onOpen: (group: ContactGroup, bot: SharedBot) => void;
}

export default function RemoteDeviceGroup({ group, onOpen }: RemoteDeviceGroupProps) {
  const { t } = useTranslation("sidebar");
  return (
    <div className="flex flex-col" data-testid={`mesh-group-${group.deviceId}`}>
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5" title={group.error ?? group.address ?? ""}>
        <span
          aria-label={t(`bots.mesh.deviceStatus.${group.status}`)}
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: group.online ? "var(--app-status-success)" : "var(--app-icon-inactive)" }}
        />
        <span className="truncate text-[length:var(--text-micro)] text-[var(--app-text-secondary)]">{group.name}</span>
        {!group.online && (
          <span className="text-[length:var(--text-micro)] text-[var(--app-icon-inactive)]">
            {t(`bots.mesh.deviceStatus.${group.status}`)}
          </span>
        )}
      </div>
      {group.online && group.bots.length === 0 && (
        <span className="px-6 text-[length:var(--text-micro)] text-[var(--app-icon-inactive)]">{t("bots.mesh.noSharedBots")}</span>
      )}
      {group.bots.map((bot) => {
        const live = group.online && botIsLive(bot.status);
        return (
          <button
            key={bot.id}
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-hover)] disabled:opacity-50"
            style={group.online ? undefined : { filter: "grayscale(1)" }}
            disabled={!group.online}
            onClick={() => onOpen(group, bot)}
          >
            <span className="relative">
              <BotAvatar bot={bot} />
              {live && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-sidebar-bg,var(--app-panel-bg))]"
                  style={{ background: bot.status === "generating" ? "var(--app-status-warning)" : "var(--app-status-success)" }}
                />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-[var(--app-text-primary)]">{bot.name}</span>
              <span className="truncate text-[length:var(--text-micro)] text-[var(--app-icon-inactive)]">
                {bot.personaSummary || bot.engineId}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
