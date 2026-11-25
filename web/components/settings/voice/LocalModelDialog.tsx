// 本机转写：选模型、下载 / 取消 / 删除。引擎随第一个模型一起下载。
// 选中即写回 settings.localModel（自动保存）；下载进度由 useLocalVoice 轮询。
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import type { LocalVoiceModelStatus } from "@/services";
import type { VoiceSettings } from "@/types";
import { formatSize } from "@/utils/format";
import type { LocalVoiceController } from "./useLocalVoice";
import { VOICE_BUTTON_CLASS, VOICE_BUTTON_STYLE, VOICE_ICON_BUTTON_CLASS } from "./VoiceSettingsLayout";

export const LOCAL_MODELS = [
  { id: "sense-voice", nameKey: "voiceLocalSenseVoice", descKey: "voiceLocalSenseVoiceDesc", itn: true },
  { id: "qwen3-asr", nameKey: "voiceLocalQwen3", descKey: "voiceLocalQwen3Desc", itn: false },
] as const;

export function localModelInfo(id: string) {
  return LOCAL_MODELS.find((model) => model.id === id) ?? LOCAL_MODELS[0];
}

function ModelAction({ id, model, controller }: { id: string; model: LocalVoiceModelStatus | undefined; controller: LocalVoiceController }) {
  const { t } = useTranslation("settings");
  const progress = controller.status?.install;
  const mine = progress?.modelId === id;

  if (mine && controller.installing && progress) {
    const percent = progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
    const label = progress.stage === "extract"
      ? t("voiceLocalExtracting")
      : t("voiceLocalDownloading", {
        part: t(progress.stage === "engine" ? "voiceLocalPartEngine" : "voiceLocalPartModel"),
        received: formatSize(progress.received),
        total: formatSize(progress.total),
      });
    return (
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Progress value={progress.stage === "extract" ? null : percent} aria-label={label} className="h-1.5" />
          <p className="m-0 mt-1 text-[length:var(--text-small)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>{label}</p>
        </div>
        <button
          type="button"
          className={VOICE_ICON_BUTTON_CLASS}
          style={{ color: "var(--app-text-secondary)" }}
          aria-label={t("voiceLocalCancel")}
          title={t("voiceLocalCancel")}
          disabled={progress.stage === "extract"}
          onClick={(event) => {
            event.stopPropagation();
            void controller.cancel();
          }}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (model?.installed) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="flex items-center gap-1 text-[length:var(--text-small)]" style={{ color: "var(--app-status-success)" }}>
          <Check className="size-3.5" aria-hidden="true" />
          {t("voiceLocalInstalled")}
        </span>
        <button
          type="button"
          className={`${VOICE_ICON_BUTTON_CLASS} ms-auto`}
          style={{ color: "var(--app-text-tertiary)" }}
          aria-label={t("voiceLocalRemove", { name: t(localModelInfo(id).nameKey) })}
          title={t("voiceLocalRemove", { name: t(localModelInfo(id).nameKey) })}
          onClick={(event) => {
            event.stopPropagation();
            void controller.remove(id);
          }}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    );
  }

  const failed = mine && progress?.stage === "error" ? progress.error : null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {failed ? (
        <p role="alert" className="m-0 break-words text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>
          {t("voiceLocalFailed", { error: failed })}
        </p>
      ) : null}
      <button
        type="button"
        className={`${VOICE_BUTTON_CLASS} self-start`}
        style={VOICE_BUTTON_STYLE}
        disabled={controller.installing || !model}
        onClick={(event) => {
          event.stopPropagation();
          void controller.install(id);
        }}
      >
        <Download aria-hidden="true" />
        {failed ? t("voiceLocalRetry") : t("voiceLocalDownload", { size: formatSize(model?.downloadSize ?? 0) })}
      </button>
    </div>
  );
}

export default function LocalModelDialog({
  open,
  onOpenChange,
  value,
  onChange,
  controller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: VoiceSettings;
  onChange: (value: VoiceSettings) => void;
  controller: LocalVoiceController;
}) {
  const { t } = useTranslation("settings");
  const status = controller.status;
  const selected = localModelInfo(value.localModel);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("voiceLocalDialogTitle")}</DialogTitle>
          <DialogDescription>{t("voiceLocalHint")}</DialogDescription>
        </DialogHeader>

        {status && !status.supported ? (
          <p className="m-0 text-[length:var(--text-row)]" style={{ color: "var(--app-text-secondary)" }}>{t("voiceLocalUnsupported")}</p>
        ) : (
          <div role="radiogroup" aria-label={t("voiceLocalModel")} className="flex flex-col gap-2">
            {LOCAL_MODELS.map((info) => {
              const checked = info.id === selected.id;
              const model = status?.models.find((entry) => entry.id === info.id);
              return (
                <div
                  key={info.id}
                  role="radio"
                  aria-checked={checked}
                  tabIndex={0}
                  onClick={() => onChange({ ...value, localModel: info.id })}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== " " && event.key !== "Enter")) return;
                    event.preventDefault();
                    onChange({ ...value, localModel: info.id });
                  }}
                  className="rounded-lg border px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                  style={{
                    borderColor: checked ? "var(--app-accent)" : "var(--app-border)",
                    background: checked ? "var(--app-active-bg)" : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="flex size-3.5 shrink-0 items-center justify-center rounded-full border"
                      style={{ borderColor: checked ? "var(--app-accent)" : "var(--app-text-tertiary)" }}
                    >
                      {checked ? <span className="size-1.5 rounded-full" style={{ background: "var(--app-accent)" }} /> : null}
                    </span>
                    <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t(info.nameKey)}</span>
                  </div>
                  <p className="m-0 mt-1 ps-5.5 text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{t(info.descKey)}</p>
                  <div className="ps-5.5">
                    {status ? <ModelAction id={info.id} model={model} controller={controller} /> : <Loader2 className="mt-2 size-3.5 animate-spin" aria-hidden="true" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {selected.itn ? (
          <div className="flex items-start justify-between gap-4">
            <label htmlFor="voice-local-itn" className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
              {t("voiceEnableItn")}
            </label>
            <Switch id="voice-local-itn" checked={value.enableItn} onCheckedChange={(checked) => onChange({ ...value, enableItn: checked })} />
          </div>
        ) : null}

        {controller.error ? (
          <p role="alert" className="m-0 break-words text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>{controller.error}</p>
        ) : null}
        <p className="m-0 break-all text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("voiceLocalSource")}
          {status?.directory ? <><br />{t("voiceLocalDirectory", { path: status.directory })}</> : null}
        </p>

        <DialogFooter>
          <button
            type="button"
            className={VOICE_BUTTON_CLASS}
            style={{ borderColor: "var(--app-accent)", background: "var(--app-accent)", color: "var(--primary-foreground)" }}
            onClick={() => onOpenChange(false)}
          >
            {t("voiceDone")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
