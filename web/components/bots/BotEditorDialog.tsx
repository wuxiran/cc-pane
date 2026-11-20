// 新建 / 编辑 Bot：名字、头像、人设、引擎、工作目录、自动放行。
// 工作目录留空 = Bot 住在自己的家目录，人设写进 CLAUDE.md / AGENTS.md（最稳）；
// 绑项目目录时不往仓库写文件，人设随新话题的第一条消息隐式带上。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastErr } from "@/lib/feedback";
import { listAcpEngines } from "@/services/agentChatService";
import { botService } from "@/services/botService";
import type { AcpEngineInfo } from "@/types/agentChat";
import type { Bot } from "@/types/bot";
import BotAvatar from "./BotAvatar";

const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#64748b"];
const AUTO_APPROVE_ALL = "*";

interface BotEditorDialogProps {
  /** null = 关闭；id 为空 = 新建。 */
  bot: Bot | null;
  onClose: () => void;
  onSaved: (bot: Bot) => void;
}

export default function BotEditorDialog({ bot, onClose, onSaved }: BotEditorDialogProps) {
  const { t } = useTranslation("sidebar");
  const [draft, setDraft] = useState<Bot | null>(bot);
  const [engines, setEngines] = useState<AcpEngineInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(bot), [bot]);
  useEffect(() => {
    if (!bot) return;
    listAcpEngines()
      .then((list) => {
        setEngines(list);
        setDraft((current) =>
          current && !current.engineId
            ? { ...current, engineId: list.find((engine) => engine.available)?.id ?? list[0]?.id ?? "" }
            : current,
        );
      })
      .catch((error) => toastErr(String(error)));
  }, [bot]);

  if (!draft) return null;
  const isNew = !draft.id;
  const autoApproveAll = draft.autoApproveKinds.includes(AUTO_APPROVE_ALL);
  const selectClass =
    "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 text-[length:var(--text-small)]";

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDraft({ ...draft, cwd: picked });
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await botService.save(draft);
      onSaved(saved);
    } catch (error) {
      toastErr(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="bot-editor">
        <DialogHeader>
          <DialogTitle>{isNew ? t("bots.create") : t("bots.edit")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            <BotAvatar bot={draft} size={36} />
            <FormField label={t("bots.name")} className="flex flex-1 flex-col gap-1.5" labelClassName="text-[length:var(--text-small)]">
              {({ id }) => (
                <Input id={id} value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              )}
            </FormField>
            <FormField label={t("bots.avatar")} className="flex w-20 flex-col gap-1.5" labelClassName="text-[length:var(--text-small)]">
              {({ id }) => (
                <Input id={id} value={draft.avatar} maxLength={4} onChange={(event) => setDraft({ ...draft, avatar: event.target.value })} />
              )}
            </FormField>
          </div>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("bots.color")}>
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={draft.color === color}
                aria-label={color}
                className="h-5 w-5 rounded-full outline-offset-2"
                style={{ background: color, outline: draft.color === color ? `2px solid ${color}` : "none" }}
                onClick={() => setDraft({ ...draft, color })}
              />
            ))}
          </div>
          <FormField label={t("bots.persona")} hint={t("bots.personaHint")} hintClassName="text-[length:var(--text-micro)] text-[var(--app-text-muted)]" className="flex flex-col gap-1.5" labelClassName="text-[length:var(--text-small)]">
            {({ id }) => (
              <textarea
                id={id}
                className="min-h-[120px] rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-[length:var(--text-small)]"
                value={draft.persona}
                placeholder={t("bots.personaPlaceholder")}
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t("bots.engine")} className="flex flex-col gap-1.5" labelClassName="text-[length:var(--text-small)]">
            {({ id }) => (
              <select id={id} className={selectClass} value={draft.engineId} onChange={(event) => setDraft({ ...draft, engineId: event.target.value })}>
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.id} disabled={!engine.available}>
                    {engine.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t("bots.cwd")} hint={t("bots.cwdHint")} hintClassName="text-[length:var(--text-micro)] text-[var(--app-text-muted)]" className="flex flex-col gap-1.5" labelClassName="text-[length:var(--text-small)]">
            {({ id }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  value={draft.cwd ?? ""}
                  placeholder={t("bots.cwdHome")}
                  onChange={(event) => setDraft({ ...draft, cwd: event.target.value || null })}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
                  {t("bots.browse")}
                </Button>
              </div>
            )}
          </FormField>
          <label className="flex items-center justify-between gap-3 text-[length:var(--text-small)]">
            <span>
              {t("bots.autoApprove")}
              <span className="block text-[length:var(--text-micro)] text-[var(--app-text-muted)]">{t("bots.autoApproveHint")}</span>
            </span>
            <Switch
              checked={autoApproveAll}
              onCheckedChange={(checked) => setDraft({ ...draft, autoApproveKinds: checked ? [AUTO_APPROVE_ALL] : [] })}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("bots.cancel")}</Button>
          <Button disabled={saving || !draft.name.trim() || !draft.engineId} onClick={() => void save()}>
            {t("bots.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

