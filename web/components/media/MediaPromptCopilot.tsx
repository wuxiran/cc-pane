import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { completePrompt, supportsPromptCompletion } from "@/services/promptCopilotService";
import { useProvidersStore } from "@/stores";
import { getErrorMessage } from "@/utils";

export type CopilotMode = "generate" | "refine" | "expand" | "translate";

interface MediaPromptCopilotProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fill the generation form's prompt with the copilot output. */
  onApplyPrompt?: (text: string) => void;
  /** Persist the copilot output as a text node on the canvas. */
  onSaveNode?: (text: string) => Promise<void> | void;
}

const SYSTEM_PROMPTS: Record<CopilotMode, string> = {
  generate: "You are a prompt engineer for AI image and video generation. Turn the user's idea into one vivid, concrete generation prompt. Describe subject, style, lighting, composition and mood. Reply with the prompt text only, no commentary.",
  refine: "You are a prompt engineer for AI image and video generation. Rewrite the user's prompt to be clearer and more effective while preserving its intent. Reply with the improved prompt text only, no commentary.",
  expand: "You are a prompt engineer for AI image and video generation. Expand the user's prompt with rich, concrete visual detail (subject, style, lighting, composition, camera, mood). Reply with the expanded prompt text only, no commentary.",
  translate: "You are a prompt engineer for AI image and video generation. Translate the user's prompt into fluent English optimized for generation models, preserving all visual details. Reply with the translated prompt text only, no commentary.",
};

/**
 * Cmd/Ctrl+K prompt copilot for the media studio. Reuses saved LLM providers
 * for a one-shot completion; output can be pushed into the generation form or
 * saved as a text node on the canvas.
 */
export default function MediaPromptCopilot({ open, onOpenChange, onApplyPrompt, onSaveNode }: MediaPromptCopilotProps) {
  const { t } = useTranslation("media");
  const providers = useProvidersStore((state) => state.providers);
  const eligibleProviders = useMemo(() => providers.filter(supportsPromptCompletion), [providers]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<CopilotMode>("generate");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);

  const provider = useMemo(
    () => eligibleProviders.find((candidate) => candidate.id === providerId) ?? eligibleProviders[0] ?? null,
    [eligibleProviders, providerId],
  );

  // Follow the provider's default model whenever the provider changes.
  useEffect(() => {
    if (!provider) return;
    setModelId((current) => current || (provider.defaultModelId ?? provider.models?.[0]?.id ?? ""));
  }, [provider]);

  const run = async () => {
    if (!provider || !input.trim() || !modelId.trim()) return;
    setRunning(true);
    try {
      const text = await completePrompt({
        provider,
        modelId: modelId.trim(),
        system: SYSTEM_PROMPTS[mode],
        prompt: input.trim(),
      });
      setOutput(text);
    } catch (error) {
      toast.error(t("copilotFailed", { message: getErrorMessage(error) }));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="media-prompt-copilot">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
            {t("copilotTitle")}
          </DialogTitle>
        </DialogHeader>
        {eligibleProviders.length === 0 ? (
          <p className="py-4 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("copilotNoProviders")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={provider?.id ?? ""} onValueChange={(value) => { setProviderId(value); setModelId(""); }}>
                <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                  <SelectValue placeholder={t("copilotProvider")} />
                </SelectTrigger>
                <SelectContent>
                  {eligibleProviders.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="h-7 w-48 text-xs"
                value={modelId}
                placeholder={t("copilotModelPlaceholder")}
                list="media-copilot-models"
                onChange={(event) => setModelId(event.target.value)}
              />
              <datalist id="media-copilot-models">
                {(provider?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
              </datalist>
            </div>
            <SegmentedTabs<CopilotMode>
              aria-label={t("copilotMode")}
              value={mode}
              onValueChange={setMode}
              size="sm"
              items={[
                { value: "generate", label: t("copilotModeGenerate") },
                { value: "refine", label: t("copilotModeRefine") },
                { value: "expand", label: t("copilotModeExpand") },
                { value: "translate", label: t("copilotModeTranslate") },
              ]}
            />
            <textarea
              className="h-24 w-full resize-none rounded-md border bg-transparent p-2 text-xs outline-none"
              style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
              data-testid="copilot-input"
              value={input}
              placeholder={t("copilotInputPlaceholder")}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void run();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" className="h-7 gap-1.5 text-xs" disabled={running || !input.trim() || !modelId.trim()} onClick={() => void run()}>
                {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="size-3.5" aria-hidden="true" />}
                {running ? t("copilotRunning") : t("copilotRun")}
              </Button>
              <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("copilotRunHint")}</span>
            </div>
            <textarea
              className="h-32 w-full resize-none rounded-md border bg-transparent p-2 text-xs outline-none"
              style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
              data-testid="copilot-output"
              value={output}
              placeholder={t("copilotOutputPlaceholder")}
              onChange={(event) => setOutput(event.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              {onSaveNode ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!output.trim()}
                  onClick={() => { void onSaveNode(output.trim()); onOpenChange(false); }}
                >
                  {t("copilotSaveNode")}
                </Button>
              ) : null}
              {onApplyPrompt ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!output.trim()}
                  onClick={() => { onApplyPrompt(output.trim()); onOpenChange(false); }}
                >
                  {t("copilotApply")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
