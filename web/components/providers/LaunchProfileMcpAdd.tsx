// MCP 卡的「新增」：新建一个共享 MCP（保存后直接开给本配置），或从已有共享 MCP 里勾选。
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Compass, Plus } from "lucide-react";
import SharedMcpEditorDialog from "@/components/resources/SharedMcpEditorDialog";
import { Button } from "@/components/ui/button";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import type { LaunchProfileDraft } from "@/types";
import AddPicker from "./LaunchProfileAddPicker";
import { isSharedMcpServerSelected } from "./launchProfileHelpers";
import { nextSetSharedMcp } from "./launchProfileAddModel";

interface LaunchProfileMcpAddProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
}

export default function LaunchProfileMcpAdd({ draft, setDraft }: LaunchProfileMcpAddProps) {
  const { t } = useTranslation("providers");
  const servers = useSharedMcpStore((s) => s.servers);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (open) void fetchStatus();
  }, [open, fetchStatus]);

  const disabled = draft.mcpPolicy.mode === "disabled";
  // 保存时读 store 最新列表：upsertServer 已刷新过，新建的 server 也在里面
  const setShared = (name: string, on: boolean) => {
    const names = useSharedMcpStore.getState().servers.map((server) => server.name);
    setDraft((current) => nextSetSharedMcp(current, name, on, names));
  };

  return (
    <>
      <AddPicker
        testId="mcp-add"
        title={t("profileAdd.mcpTitle")}
        open={open}
        onOpenChange={setOpen}
        disabledNote={disabled ? t("profileAdd.mcpDisabled") : null}
        emptyText={t("profileAdd.mcpEmpty")}
        groups={[{
          items: servers.map((server) => ({
            key: server.name,
            name: server.name,
            description: server.config.remote?.url ?? ([server.config.command, ...server.config.args].join(" ").trim() || null),
            checked: isSharedMcpServerSelected(draft.mcpPolicy, server.name),
          })),
        }]}
        onToggle={setShared}
        footer={(
          <>
            <Button size="xs" variant="ghost" data-testid="mcp-add-new" onClick={() => { setOpen(false); setEditorOpen(true); }}>
              <Plus size={12} /> {t("profileAdd.mcpNew")}
            </Button>
            <Button size="xs" variant="ghost" data-testid="mcp-add-discover" onClick={() => { setOpen(false); openResourceLibrary("mcp"); }}>
              <Compass size={12} /> {t("profileAdd.mcpDiscover")}
            </Button>
          </>
        )}
      />
      <SharedMcpEditorDialog
        open={editorOpen}
        server={null}
        onOpenChange={setEditorOpen}
        onSaved={(name) => setShared(name, true)}
      />
    </>
  );
}
