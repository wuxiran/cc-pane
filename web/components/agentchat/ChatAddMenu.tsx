import { useMemo, useRef, useState } from "react";
import { Camera, FilePlus2, Folder, FolderOpen, Layers, LoaderCircle, Plus, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, isChatDraftCurrent } from "@/stores/useAgentChatDraftStore";
import { usePanesStore } from "@/stores/usePanesStore";
import { agentChatService } from "@/services/agentChatService";
import type { AcpChatPhase } from "@/types/agentChat";
import { translateError } from "@/utils/errorTranslation";
import { baseName } from "./chatAttachments";
import { chatModeGroups, type ChatModeGroup } from "./chatAddModes";
import { saveEngineModes, savePreferredMode } from "./enginePrefs";

interface ChatAddMenuProps {
  chatId: string;
  cwd: string;
  phase?: AcpChatPhase;
  generating: boolean;
  blocked: boolean;
  onFiles: () => Promise<void>;
  onFolders: () => Promise<void>;
  onProject: () => void;
  onCapture?: () => void;
}

export default function ChatAddMenu({ chatId, cwd, phase, generating, blocked, onFiles, onFolders, onProject, onCapture }: ChatAddMenuProps) {
  const { t } = useTranslation("panes");
  const snapshot = useAgentChatStore((state) => state.chats[chatId]?.snapshot);
  const draftToken = useMemo(() => acquireChatDraft(chatId), [chatId]);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const groups = chatModeGroups(snapshot);
  const modeDisabled = changing || generating || blocked || phase !== "ready";
  const projectName = baseName(cwd.replace(/[\\/]+$/, "")) || cwd;

  const changeMode = async (group: ChatModeGroup, value: string) => {
    const chat = useAgentChatStore.getState().chats[chatId];
    if (modeDisabled || pending.current || !chat?.snapshot || chat.snapshot.phase !== "ready"
      || chat.pendingPrompt || chat.setup?.pending || chat.setup?.error) return;
    const current = chatModeGroups(chat.snapshot).find((item) => item.id === group.id);
    if (!current || !current.choices.some((choice) => choice.id === value) || value === current.current) return;
    pending.current = true;
    setChanging(true);
    setError(null);
    try {
      if (current.configId) await agentChatService.setConfigOption(chatId, current.configId, value);
      else await agentChatService.setMode(chatId, value);
      if (!isChatDraftCurrent(chatId, draftToken)) return;
      saveEngineModes(chat.snapshot.engineId, chat.snapshot.modes?.availableModes ?? []);
      savePreferredMode(chat.snapshot.engineId, value);
      setOpen(false);
    } catch (failure) {
      if (!isChatDraftCurrent(chatId, draftToken)) return;
      const message = translateError(failure);
      setError(message);
      useAgentChatStore.getState().pushNotice(chatId, message);
    } finally {
      pending.current = false;
      setChanging(false);
    }
  };

  const attach = (action: () => Promise<void>) => {
    void action().catch((failure) => {
      if (isChatDraftCurrent(chatId, draftToken)) useAgentChatStore.getState().pushNotice(chatId, translateError(failure));
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconTooltipButton label={t("agentChatAdd")} className="h-8 w-8 shrink-0 rounded-full">
          <Plus className="h-4 w-4" />
        </IconTooltipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 max-w-[calc(100vw-2rem)] rounded-2xl p-2" aria-label={t("agentChatAdd")}>
        <DropdownMenuLabel className="text-xs text-[var(--app-text-tertiary)]">{t("agentChatAdd")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => attach(onFiles)}><FilePlus2 />{t("agentChatAddFile")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => attach(onFolders)}><Folder />{t("agentChatAddFolder")}</DropdownMenuItem>
        {cwd ? <DropdownMenuItem onSelect={onProject} title={cwd} aria-label={`${t("agentChatAttachProject")} ${projectName}`}>
          <FolderOpen /><span className="min-w-0"><span className="block">{t("agentChatAttachProject")}</span>
            <span className="block truncate text-xs text-[var(--app-text-tertiary)]">{projectName}</span></span>
        </DropdownMenuItem> : null}
        {onCapture ? <DropdownMenuItem onSelect={onCapture}><Camera />{t("agentChatCaptureScreenshot")}</DropdownMenuItem> : null}
        {groups.map((group) => <div key={group.id}>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-[var(--app-text-tertiary)]">{group.name || t("agentChatSessionModes")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={group.current} onValueChange={(value) => void changeMode(group, value)}>
            {group.choices.map((choice) => <DropdownMenuRadioItem key={choice.id} value={choice.id} disabled={modeDisabled}
              onSelect={(event) => event.preventDefault()} title={choice.description}>
              <span className="min-w-0 truncate">{choice.name}</span>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </div>)}
        {changing ? <div role="status" className="flex items-center gap-2 px-2 py-1 text-xs text-[var(--app-text-tertiary)]">
          <LoaderCircle className="h-3 w-3 animate-spin" />{t("agentChatModeChanging")}
        </div> : null}
        {error ? <div role="alert" className="max-w-full break-words px-2 py-1 text-xs text-[var(--app-status-danger)]">{error}</div> : null}
        {cwd ? <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-[var(--app-text-tertiary)]">{t("agentChatTools")}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => usePanesStore.getState().openSkillManager(cwd, projectName)}><Layers />{t("agentChatManageSkills")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => usePanesStore.getState().openMcpConfig(cwd, projectName)}><Server />{t("agentChatManageMcp")}</DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
