import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImagePlus, Link2, LoaderCircle, Paperclip, Sparkles, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/utils";
import ComfyWorkflowPicker from "./ComfyWorkflowPicker";
import { COMFY_WORKFLOW_SCHEMA_VERSION, jsonFingerprint, parseComfyWorkflow, type MediaInputAssetSelection, type MediaKind, type MediaOperation, type MediaProviderCapabilities, type MediaProtocol } from "@/types/media";

export interface MediaInputFile {
  name: string;
  mimeType: string;
  dataUrl: string;
  role?: "reference" | "mask";
}

export interface MediaGenerationValues {
  operation: MediaOperation;
  prompt: string;
  /**
   * All selected references. `inputFile` remains as a compatibility alias
   * for callers written against the first single-file slice.
   */
  inputFiles: MediaInputFile[];
  inputFile?: MediaInputFile;
  /** Existing app-owned output assets precede newly staged local files. */
  inputAssetIds?: string[];
  linkedInput?: MediaInputAssetSelection;
  parameters: Record<string, unknown>;
  priority: number;
}

type SeedMode = "random" | "fixed" | "increment";
type VideoFrameMode = "single" | "firstLast" | "continue";

interface MediaGenerationFormProps {
  kind: "image" | "video";
  providerId?: string | null;
  modelId: string | null;
  protocol?: MediaProtocol;
  capabilities?: MediaProviderCapabilities | null;
  disabled?: boolean;
  linkedInput?: MediaInputAssetSelection | null;
  onClearLinkedInput?: () => void;
  onGenerate: (values: MediaGenerationValues) => Promise<void>;
  /** Externally supplied prompt (e.g. from the copilot); applied per token. */
  externalPrompt?: { value: string; token: number } | null;
}

function readFile(file: File, sizeError: string, readError: string): Promise<MediaInputFile> {
  return new Promise((resolve, reject) => {
    if (file.size === 0 || file.size > 64 * 1024 * 1024) {
      reject(new Error(sizeError));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(readError));
    reader.onload = () => resolve({ name: file.name, mimeType: file.type || "application/octet-stream", dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  });
}

function expectedInputKind(kind: MediaKind, operation: MediaOperation): MediaKind | null {
  if (operation === "imageToImage" || operation === "imageToVideo") return "image";
  if (operation === "edit" || operation === "upscale" || operation === "extend") return kind;
  return null;
}

function preferredOperationForLinkedInput(kind: MediaKind, sourceKind: MediaKind): MediaOperation | null {
  if (kind === "image" && sourceKind === "image") return "imageToImage";
  if (kind === "video" && sourceKind === "image") return "imageToVideo";
  if (kind === "video" && sourceKind === "video") return "extend";
  return null;
}

export default function MediaGenerationForm({ kind, providerId = null, modelId, protocol = "sub2api", capabilities = null, disabled = false, linkedInput = null, onClearLinkedInput, onGenerate, externalPrompt = null }: MediaGenerationFormProps) {
  const { t } = useTranslation("media");
  const [operation, setOperation] = useState<MediaOperation>(kind === "image" ? "textToImage" : "textToVideo");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (externalPrompt) setPrompt(externalPrompt.value);
    // Applied once per token so users can keep editing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt?.token]);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [inputFiles, setInputFiles] = useState<MediaInputFile[]>([]);
  const [maskFile, setMaskFile] = useState<MediaInputFile | null>(null);
  const [size, setSize] = useState(kind === "image" ? "1024x1024" : "1280x720");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [quality, setQuality] = useState("standard");
  const [steps, setSteps] = useState("28");
  const [cfgScale, setCfgScale] = useState("7");
  const [sampler, setSampler] = useState("euler");
  const [denoise, setDenoise] = useState("0.7");
  const [upscaleScale, setUpscaleScale] = useState("2");
  const [count, setCount] = useState("1");
  const [seed, setSeed] = useState("");
  const [seedMode, setSeedMode] = useState<SeedMode>("random");
  const [duration, setDuration] = useState("5");
  const [fps, setFps] = useState("24");
  const [resolution, setResolution] = useState("1080p");
  const [audio, setAudio] = useState(true);
  const [codec, setCodec] = useState("h264");
  const [colorSpace, setColorSpace] = useState("bt709");
  const [frameMode, setFrameMode] = useState<VideoFrameMode>(kind === "video" && operation === "extend" ? "continue" : "single");
  const [priority, setPriority] = useState("0");
  const [workflowJson, setWorkflowJson] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const maskInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // The image and video entry points share one mounted workspace. Reset
    // type-specific defaults when switching so a video never inherits an
    // image operation or an image workflow selection.
    setOperation(kind === "image" ? "textToImage" : "textToVideo");
    setPrompt("");
    setNegativePrompt("");
    setInputFiles([]);
    setMaskFile(null);
    setSize(kind === "image" ? "1024x1024" : "1280x720");
    setFrameMode("single");
    setWorkflowJson("");
  }, [kind]);
  const needsInput = operation !== "textToImage" && operation !== "textToVideo"
    || kind === "video" && frameMode === "firstLast";
  const requiresTwoFrames = kind === "video" && frameMode === "firstLast";
  const acceptsVideoReference = kind === "video" && (operation === "edit" || operation === "extend" || frameMode === "continue");
  const inputAccept = acceptsVideoReference ? "video/*" : "image/*";
  const referenceFiles = maskFile ? [...inputFiles, maskFile] : inputFiles;
  const linkedInputMatchesOperation = linkedInput !== null
    && expectedInputKind(kind, operation) === linkedInput.mediaKind;
  const linkedInputCount = linkedInputMatchesOperation ? 1 : 0;
  const primaryInputCount = linkedInputCount + inputFiles.length;
  // API workflows can carry their own text encoder inputs. Keep the prompt
  // optional for ComfyUI while retaining the required prompt for generic APIs.
  const promptRequired = protocol !== "comfyui";
  // Sub2API task bodies are whitelisted server-side; only render fields the
  // upstream actually accepts (docs/101-sub2api-media-api.md).
  const isSub2api = protocol === "sub2api";
  // SD-style knobs (steps/CFG/sampler/seed/codec…) only exist for ComfyUI
  // workflows. Real HTTP APIs (OpenAI-compatible, Sub2API) reject or ignore
  // them, so they never render outside the ComfyUI protocol (docs/99 P0).
  const isComfy = protocol === "comfyui";

  useEffect(() => {
    // Keep the quality value inside the option set of the active protocol.
    if (!isComfy && !["low", "medium", "high", "auto"].includes(quality)) setQuality("high");
    if (isComfy && !["standard", "hd", "ultra"].includes(quality)) setQuality("standard");
  }, [isComfy, quality]);

  const operationLabel = useMemo(() => kind === "image"
    ? { textToImage: t("textToImage"), imageToImage: t("imageToImage"), edit: t("imageEdit"), upscale: t("imageUpscale") }
    : { textToVideo: t("textToVideo"), imageToVideo: t("imageToVideo"), edit: t("videoEdit"), extend: t("videoExtend") }, [kind, t]);
  const supportedOperations = useMemo(() => {
    const declared = capabilities?.operations ?? (Object.keys(operationLabel) as MediaOperation[]);
    return declared.filter((candidate): candidate is MediaOperation => Object.prototype.hasOwnProperty.call(operationLabel, candidate));
  }, [capabilities?.operations, operationLabel]);
  const operationIsSupported = supportedOperations.includes(operation);

  useEffect(() => {
    if (supportedOperations.length === 0 || operationIsSupported) return;
    const next = supportedOperations[0];
    setOperation(next);
    if (kind === "video") setFrameMode(next === "extend" ? "continue" : "single");
  }, [kind, operationIsSupported, supportedOperations]);

  useEffect(() => {
    if (!linkedInput) return;
    const preferred = preferredOperationForLinkedInput(kind, linkedInput.mediaKind);
    if (!preferred || !supportedOperations.includes(preferred)) return;
    setOperation(preferred);
    if (kind === "video") setFrameMode(preferred === "extend" ? "continue" : "single");
  }, [kind, linkedInput, supportedOperations]);

  function changeOperation(value: MediaOperation) {
    if (!supportedOperations.includes(value)) return;
    setOperation(value);
    if (kind === "video") setFrameMode(value === "extend" ? "continue" : "single");
    if (value === "textToImage" || value === "textToVideo") {
      setInputFiles([]);
      onClearLinkedInput?.();
    }
    if (kind !== "image" || value !== "edit") setMaskFile(null);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    try {
      const selected = await Promise.all(files.map((file) => readFile(
        file,
        t("referenceAssetSizeError"),
        t("referenceAssetReadError"),
      )));
      setInputFiles((current) => [...current, ...selected].slice(0, 32));
    } catch (error) {
      toast.error(getErrorMessage(error) || t("referenceAssetReadError"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleMaskChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const selected = await readFile(
        file,
        t("maskAssetSizeError"),
        t("referenceAssetReadError"),
      );
      setMaskFile({ ...selected, role: "mask" });
    } catch (error) {
      toast.error(getErrorMessage(error) || t("referenceAssetReadError"));
    } finally {
      if (maskInputRef.current) maskInputRef.current.value = "";
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || submitting || !modelId || !operationIsSupported || (promptRequired && !prompt.trim()) || (needsInput && primaryInputCount === 0) || (requiresTwoFrames && primaryInputCount < 2)) return;
    setSubmitting(true);
    try {
      const selectedInputFiles = referenceFiles;
      const batchSize = Math.max(1, Math.min(8, Number(count) || 1));
      const seedNumber = seed.trim() === "" ? null : Number(seed);
      const hasSeed = seedNumber !== null && Number.isSafeInteger(seedNumber);
      const baseParameters = {
        seedMode,
        ...(hasSeed ? {
          seed: seedNumber,
          variantSeeds: Array.from({ length: batchSize }, (_, index) => seedMode === "increment" ? (seedNumber as number) + index : seedNumber),
        } : {}),
      };
      const parameters: Record<string, unknown> = kind === "image"
        ? {
          size,
          aspectRatio,
          quality,
          n: batchSize,
          batchSize,
          negativePrompt: negativePrompt.trim() || undefined,
          steps: Math.max(1, Math.min(200, Number(steps) || 28)),
          cfgScale: Math.max(0, Math.min(50, Number(cfgScale) || 7)),
          sampler,
          ...(operation === "edit" || operation === "imageToImage" ? { denoise: Math.max(0, Math.min(1, Number(denoise) || 0.7)) } : {}),
          ...(operation === "upscale" ? { scale: Math.max(1, Math.min(8, Number(upscaleScale) || 2)) } : {}),
          ...(maskFile ? { maskInputIndex: linkedInputCount + inputFiles.length } : {}),
          ...baseParameters,
        }
        : {
          size,
          resolution,
          aspectRatio,
          duration: Math.max(1, Math.min(60, Number(duration) || 5)),
          fps: Math.max(1, Math.min(60, Number(fps) || 24)),
          frameCount: Math.max(1, Math.min(3600, Math.round((Number(duration) || 5) * (Number(fps) || 24)))),
          audio,
          codec,
          colorSpace,
          frameMode,
          ...(kind === "video" && frameMode === "firstLast" ? { firstFrameIndex: 0, lastFrameIndex: primaryInputCount > 1 ? 1 : null } : {}),
          ...(kind === "video" && frameMode === "continue" ? { continuationAssetIndex: 0 } : {}),
          n: batchSize,
          batchSize,
          ...baseParameters,
        };
      if (protocol === "comfyui") {
        if (!workflowJson.trim()) {
          toast.error(t("comfyWorkflowRequired"));
          return;
        }
        let parsedWorkflow: ReturnType<typeof parseComfyWorkflow>;
        try {
          parsedWorkflow = parseComfyWorkflow(JSON.parse(workflowJson));
        } catch {
          toast.error(t("comfyWorkflowInvalid"));
          return;
        }
        if (!parsedWorkflow.workflow) {
          toast.error(parsedWorkflow.error === "ui_format" ? t("comfyUiWorkflowUnsupported") : t("comfyWorkflowInvalid"));
          return;
        }
        parameters.workflow = parsedWorkflow.workflow;
        parameters.workflowSchemaVersion = COMFY_WORKFLOW_SCHEMA_VERSION;
        parameters.workflowFormat = "api";
        const fingerprint = await jsonFingerprint(parsedWorkflow.workflow);
        if (/^[0-9a-f]{64}$/i.test(fingerprint)) parameters.workflowFingerprint = fingerprint;
      }
      await onGenerate({
        operation,
        prompt: prompt.trim(),
        inputFiles: selectedInputFiles,
        inputFile: selectedInputFiles[0],
        inputAssetIds: linkedInputMatchesOperation && linkedInput ? [linkedInput.assetId] : [],
        linkedInput: linkedInputMatchesOperation && linkedInput ? linkedInput : undefined,
        parameters,
        priority: Math.max(-100, Math.min(100, Number(priority) || 0)),
      });
      setPrompt("");
      setInputFiles([]);
      setMaskFile(null);
      onClearLinkedInput?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-3 px-3 py-3" onSubmit={(event) => void submit(event)} data-testid={`media-generation-form-${kind}`}>
      <div className="flex items-center gap-2"><div className="flex size-7 items-center justify-center rounded-md" style={{ color: "var(--app-accent)", background: "color-mix(in srgb, var(--app-accent) 12%, transparent)" }}>{kind === "image" ? <ImagePlus className="size-4" aria-hidden="true" /> : <Film className="size-4" aria-hidden="true" />}</div><div><h2 className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>{kind === "image" ? t("generateImage") : t("generateVideo")}</h2><p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{modelId ? t("usingModel", { model: modelId }) : t("configureModel")}</p></div></div>
      {supportedOperations.length > 0 ? <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--app-border)] p-1" role="group" aria-label={t("generationMode")}>
        {supportedOperations.map((value) => <button type="button" key={value} className="rounded px-2 py-1.5 text-[11px] transition-colors" style={{ color: operation === value ? "var(--app-accent)" : "var(--app-text-secondary)", background: operation === value ? "color-mix(in srgb, var(--app-accent) 12%, transparent)" : undefined }} onClick={() => changeOperation(value)}>{operationLabel[value as keyof typeof operationLabel]}</button>)}
      </div> : <p className="text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("noSupportedOperations")}</p>}
      <div className="space-y-1.5"><Label htmlFor={`media-prompt-${kind}`} className="text-[11px]">{t("prompt")}</Label><textarea id={`media-prompt-${kind}`} value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder={t(kind === "image" ? "imagePromptPlaceholder" : "videoPromptPlaceholder")} className="w-full resize-y rounded-md border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--app-accent)]" /></div>
      {kind === "image" && isComfy ? <div className="space-y-1.5"><Label htmlFor={`media-negative-prompt-${kind}`} className="text-[11px]">{t("negativePrompt")}</Label><textarea id={`media-negative-prompt-${kind}`} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} rows={2} placeholder={t("negativePromptPlaceholder")} className="w-full resize-y rounded-md border border-[var(--app-border)] bg-transparent px-3 py-2 text-xs outline-none focus:border-[var(--app-accent)]" /></div> : null}
      {protocol === "comfyui" ? (
        <section className="space-y-2 rounded-md border border-[var(--app-border)] p-2" data-testid="comfy-workflow-section">
          <div className="flex min-w-0 items-start gap-2">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--app-text-primary)" }}>
                <span>{t("comfyReadyWorkflow")}</span>
                <span className="rounded border border-[var(--app-border)] px-1 py-0.5 text-[9px] font-normal" style={{ color: workflowJson.trim() ? "var(--app-status-success)" : "var(--app-status-warning)" }}>
                  {workflowJson.trim() ? t("comfyWorkflowReady") : t("comfyWorkflowNotConfigured")}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] font-normal" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyWorkflowSimpleHelp")}</p>
            </div>
          </div>
          <ComfyWorkflowPicker providerId={providerId} value={workflowJson} onChange={setWorkflowJson} />
          {!workflowJson.trim() ? <p className="text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("comfyReadyWorkflowRequired")}</p> : null}
        </section>
      ) : null}
      {kind === "video" && protocol !== "open_ai_compatible" ? <div className="space-y-1.5"><Label className="text-[11px]">{t("frameMode")}</Label><Select value={frameMode} onValueChange={(value) => { setFrameMode(value as VideoFrameMode); if (value === "single") setInputFiles([]); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single">{t("frameSingle")}</SelectItem><SelectItem value="firstLast">{t("frameFirstLast")}</SelectItem><SelectItem value="continue">{t("frameContinue")}</SelectItem></SelectContent></Select></div> : null}
      {needsInput ? (
        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("referenceAsset")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" multiple accept={inputAccept} className="sr-only" onChange={(event) => void handleFileChange(event)} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}><Upload aria-hidden="true" />{t("chooseFile")}</Button>
            {primaryInputCount === 0 ? <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("referenceAssetHint")}</span> : null}
            {linkedInput ? <span className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--app-accent)] px-1.5 py-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }} data-testid="linked-media-input">
              <span className="shrink-0 text-[9px] tabular-nums">#1</span><Link2 className="size-3 shrink-0" aria-hidden="true" /><span className="max-w-40 truncate">{linkedInput.name}</span>
              <button type="button" className="ml-0.5 text-[var(--app-text-tertiary)] hover:text-[var(--app-status-danger)]" aria-label={t("removeLinkedReference", { name: linkedInput.name })} title={t("removeLinkedReference", { name: linkedInput.name })} onClick={onClearLinkedInput}><X className="size-3" aria-hidden="true" /></button>
            </span> : null}
            {inputFiles.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
              <span className="shrink-0 text-[9px] tabular-nums">#{index + linkedInputCount + 1}</span><Paperclip className="size-3 shrink-0" aria-hidden="true" /><span className="max-w-40 truncate">{file.name}</span>
              <button type="button" className="ml-0.5 text-[var(--app-text-tertiary)] hover:text-[var(--app-status-danger)]" aria-label={t("removeReference", { name: file.name })} title={t("removeReference", { name: file.name })} onClick={() => setInputFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X className="size-3" aria-hidden="true" /></button>
            </span>)}
            {maskFile ? <span className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--app-accent)] px-1.5 py-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
              <span className="shrink-0 text-[9px] tabular-nums">#{linkedInputCount + referenceFiles.length}</span><Paperclip className="size-3 shrink-0" aria-hidden="true" /><span className="max-w-40 truncate">{maskFile.name} · {t("mask")}</span>
              <button type="button" className="ml-0.5 text-[var(--app-text-tertiary)] hover:text-[var(--app-status-danger)]" aria-label={t("removeMask")} title={t("removeMask")} onClick={() => setMaskFile(null)}><X className="size-3" aria-hidden="true" /></button>
            </span> : null}
          </div>
          {linkedInput && !linkedInputMatchesOperation ? <p className="text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("linkedReferenceOperationMismatch")}</p> : null}
          {kind === "image" && operation === "edit" ? <div className="flex flex-wrap items-center gap-2"><input ref={maskInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => void handleMaskChange(event)} /><Button type="button" variant="ghost" size="sm" onClick={() => maskInputRef.current?.click()}><Upload aria-hidden="true" />{maskFile ? t("replaceMask") : t("chooseMask")}</Button><span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("maskHint")}</span></div> : null}
          <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t(frameMode === "firstLast" ? "firstLastFrameHint" : frameMode === "continue" ? "videoReferenceHint" : acceptsVideoReference ? "videoReferenceHint" : "imageReferenceHint")}</p>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {/* Sub2API video sizing is resolution + aspect ratio; image sizing is
            width x height only. Hide whichever field the protocol ignores. */}
        {isSub2api && kind === "video" ? null : <div className="space-y-1.5"><Label className="text-[11px]">{t("size")}</Label><Select value={size} onValueChange={setSize}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1024x1024">1024 x 1024</SelectItem><SelectItem value="1536x1024">1536 x 1024</SelectItem><SelectItem value="1024x1536">1024 x 1536</SelectItem><SelectItem value="1280x720">1280 x 720</SelectItem><SelectItem value="1920x1080">1920 x 1080</SelectItem>{isSub2api && kind === "image" ? <><SelectItem value="2048x2048">2048 x 2048</SelectItem><SelectItem value="2048x1152">2048 x 1152</SelectItem><SelectItem value="1152x2048">1152 x 2048</SelectItem><SelectItem value="3840x2160">3840 x 2160</SelectItem></> : null}</SelectContent></Select></div>}
        {isSub2api && kind === "image" ? null : <div className="space-y-1.5"><Label className="text-[11px]">{t("aspectRatio")}</Label><Select value={aspectRatio} onValueChange={setAspectRatio}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1:1">1:1</SelectItem><SelectItem value="16:9">16:9</SelectItem><SelectItem value="9:16">9:16</SelectItem><SelectItem value="4:3">4:3</SelectItem>{isSub2api ? <><SelectItem value="3:4">3:4</SelectItem><SelectItem value="21:9">21:9</SelectItem><SelectItem value="adaptive">{t("aspectAdaptive")}</SelectItem></> : null}</SelectContent></Select></div>}
      </div>
      <details className="rounded-md border border-[var(--app-border)] px-2 py-1.5">
        <summary className="cursor-pointer text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("advancedOptions")}</summary>
        <div className="mt-2 space-y-2">
          {kind === "image" ? <><div className="grid grid-cols-2 gap-2"><div className="space-y-1.5"><Label className="text-[11px]">{t("quality")}</Label><Select value={quality} onValueChange={setQuality}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{!isComfy ? <><SelectItem value="high">{t("qualityHigh")}</SelectItem><SelectItem value="medium">{t("qualityMedium")}</SelectItem><SelectItem value="low">{t("qualityLow")}</SelectItem><SelectItem value="auto">{t("qualityAuto")}</SelectItem></> : <><SelectItem value="standard">{t("standard")}</SelectItem><SelectItem value="hd">{t("hd")}</SelectItem><SelectItem value="ultra">{t("ultra")}</SelectItem></>}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`media-count-${kind}`} className="text-[11px]">{t("count")}</Label><Input id={`media-count-${kind}`} type="number" min={1} max={8} value={count} onChange={(event) => setCount(event.target.value)} /></div></div>{isComfy ? <div className="grid grid-cols-2 gap-2"><div className="space-y-1.5"><Label htmlFor={`media-steps-${kind}`} className="text-[11px]">{t("steps")}</Label><Input id={`media-steps-${kind}`} type="number" min={1} max={200} value={steps} onChange={(event) => setSteps(event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor={`media-cfg-${kind}`} className="text-[11px]">{t("cfgScale")}</Label><Input id={`media-cfg-${kind}`} type="number" min={0} max={50} step="0.1" value={cfgScale} onChange={(event) => setCfgScale(event.target.value)} /></div><div className="space-y-1.5"><Label className="text-[11px]">{t("sampler")}</Label><Select value={sampler} onValueChange={setSampler}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="euler">Euler</SelectItem><SelectItem value="euler_a">Euler a</SelectItem><SelectItem value="dpmpp_2m">DPM++ 2M</SelectItem><SelectItem value="ddim">DDIM</SelectItem></SelectContent></Select></div>{operation === "edit" || operation === "imageToImage" ? <div className="space-y-1.5"><Label htmlFor={`media-denoise-${kind}`} className="text-[11px]">{t("denoise")}</Label><Input id={`media-denoise-${kind}`} type="number" min={0} max={1} step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} /></div> : null}{operation === "upscale" ? <div className="space-y-1.5"><Label htmlFor={`media-upscale-${kind}`} className="text-[11px]">{t("upscaleScale")}</Label><Input id={`media-upscale-${kind}`} type="number" min={1} max={8} step="0.5" value={upscaleScale} onChange={(event) => setUpscaleScale(event.target.value)} /></div> : null}</div> : null}</> : <div className="grid grid-cols-2 gap-2">{protocol !== "open_ai_compatible" ? <div className="space-y-1.5"><Label className="text-[11px]">{t("resolution")}</Label><Select value={resolution} onValueChange={setResolution}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{isSub2api ? <SelectItem value="480p">480p</SelectItem> : null}<SelectItem value="720p">720p</SelectItem><SelectItem value="1080p">1080p</SelectItem><SelectItem value="4k">4K</SelectItem></SelectContent></Select></div> : null}<div className="space-y-1.5"><Label htmlFor={`media-duration-${kind}`} className="text-[11px]">{t("durationSeconds")}</Label><Input id={`media-duration-${kind}`} type="number" min={1} max={isSub2api ? 30 : 60} value={duration} onChange={(event) => setDuration(event.target.value)} /></div>{isComfy ? <><div className="space-y-1.5"><Label htmlFor={`media-fps-${kind}`} className="text-[11px]">{t("fps")}</Label><Input id={`media-fps-${kind}`} type="number" min={1} max={60} value={fps} onChange={(event) => setFps(event.target.value)} /></div><div className="space-y-1.5"><Label className="text-[11px]">{t("codec")}</Label><Select value={codec} onValueChange={setCodec}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="h264">H.264</SelectItem><SelectItem value="h265">H.265</SelectItem><SelectItem value="vp9">VP9</SelectItem><SelectItem value="av1">AV1</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label className="text-[11px]">{t("colorSpace")}</Label><Select value={colorSpace} onValueChange={setColorSpace}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bt709">BT.709</SelectItem><SelectItem value="srgb">sRGB</SelectItem><SelectItem value="p3">Display P3</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`media-count-${kind}`} className="text-[11px]">{t("count")}</Label><Input id={`media-count-${kind}`} type="number" min={1} max={8} value={count} onChange={(event) => setCount(event.target.value)} /></div><label className="flex items-end gap-2 pb-2 text-[11px]" style={{ color: "var(--app-text-secondary)" }}><input type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} />{t("generateAudio")}</label></> : null}</div>}
          {isSub2api && kind === "video" ? <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("sub2apiVideoHint")}</p> : null}
          <div className="grid grid-cols-2 gap-2"><div className="space-y-1.5"><Label className="text-[11px]">{t("priority")}</Label><Select value={priority} onValueChange={setPriority}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="0">{t("priorityNormal")}</SelectItem><SelectItem value="50">{t("priorityHigh")}</SelectItem><SelectItem value="-50">{t("priorityLow")}</SelectItem></SelectContent></Select></div></div>
          {isComfy ? <div className="grid grid-cols-2 gap-2"><div className="space-y-1.5"><Label htmlFor={`media-seed-${kind}`} className="text-[11px]">{t("seed")}</Label><Input id={`media-seed-${kind}`} inputMode="numeric" placeholder={t("randomSeed")} value={seed} onChange={(event) => setSeed(event.target.value.replace(/[^0-9-]/g, ""))} /></div><div className="space-y-1.5"><Label className="text-[11px]">{t("seedMode")}</Label><Select value={seedMode} onValueChange={(value) => setSeedMode(value as SeedMode)}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="random">{t("seedRandom")}</SelectItem><SelectItem value="fixed">{t("seedFixed")}</SelectItem><SelectItem value="increment">{t("seedIncrement")}</SelectItem></SelectContent></Select></div></div> : null}
        </div>
      </details>
      <Button type="submit" className="w-full" disabled={disabled || submitting || !modelId || !operationIsSupported || (promptRequired && !prompt.trim()) || (needsInput && primaryInputCount === 0) || (requiresTwoFrames && primaryInputCount < 2)}>{submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{submitting ? t("submitting") : kind === "image" ? t("submitImage") : t("submitVideo")}</Button>
      {!modelId ? <p className="text-center text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("modelRequired")}</p> : null}
    </form>
  );
}
