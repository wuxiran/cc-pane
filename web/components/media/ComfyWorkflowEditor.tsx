import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Braces, Link2, RefreshCw, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useComfySchemaStore } from "@/stores";
import { classifyComfyNode, parseComfyWorkflow, type ComfyInputSpec, type ComfyNodeBranch, type ComfyNodeDefinition, type ComfyWorkflow, type ComfyWorkflowNode } from "@/types/media";
import ComfyWorkflowTemplateControls from "./ComfyWorkflowTemplateControls";

interface ComfyWorkflowEditorProps {
  providerId: string | null;
  value: string;
  referenceCount?: number;
  referenceNames?: string[];
  showTemplateControls?: boolean;
  onChange: (value: string) => void;
  onSchemaFingerprintChange?: (fingerprint: string | null) => void;
  onPartialExecutionTargetsChange?: (targets: string[]) => void;
}

interface InputDescriptor {
  name: string;
  spec: ComfyInputSpec;
  required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function descriptors(definition: ComfyNodeDefinition | undefined): InputDescriptor[] {
  const groups = definition?.input;
  if (!groups) return [];
  const result: InputDescriptor[] = [];
  for (const [name, spec] of Object.entries(groups.required ?? {})) {
    if (Array.isArray(spec)) result.push({ name, spec: spec as ComfyInputSpec, required: true });
  }
  for (const [name, spec] of Object.entries(groups.optional ?? {})) {
    if (Array.isArray(spec) && !result.some((item) => item.name === name)) {
      result.push({ name, spec: spec as ComfyInputSpec, required: false });
    }
  }
  return result.slice(0, 64);
}

function inputType(spec: ComfyInputSpec): string {
  return typeof spec[0] === "string" ? spec[0].toUpperCase() : "CUSTOM";
}

function choices(spec: ComfyInputSpec): unknown[] | null {
  return Array.isArray(spec[0]) ? spec[0] : null;
}

function options(spec: ComfyInputSpec): Record<string, unknown> {
  return isRecord(spec[1]) ? spec[1] : {};
}

function formatFingerprint(value: string | undefined): string {
  return value ? `${value.slice(0, 12)}...` : "-";
}

const BRANCHES: ComfyNodeBranch[] = ["lora", "controlnet", "ipAdapter"];

function displayName(name: string, spec: ComfyInputSpec): string {
  const opts = options(spec);
  return typeof opts.label_on === "string" ? opts.label_on : name.replace(/_/g, " ");
}

function isOutputNode(node: ComfyWorkflowNode, definition: ComfyNodeDefinition | undefined): boolean {
  const classType = node.class_type.toLowerCase();
  return Boolean(definition?.output_name?.length)
    || classType.startsWith("save")
    || classType.startsWith("preview")
    || classType.includes("output")
    || classType.includes("videocombine")
    || classType.includes("video_combine");
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

function valueForInput(value: unknown, spec: ComfyInputSpec): string {
  if (value === undefined || value === null) {
    const defaultValue = options(spec).default;
    return defaultValue === undefined ? "" : String(defaultValue);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function isLink(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number");
}

function inputPlaceholderIndex(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\{\{input:(\d+)\}\}$/.exec(value.trim());
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

function parseScalar(type: string, value: string): unknown {
  if (type === "INT") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (type === "FLOAT") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (type === "BOOLEAN") return value === "true";
  return value;
}

export default function ComfyWorkflowEditor({
  providerId,
  value,
  referenceCount = 0,
  referenceNames = [],
  showTemplateControls = true,
  onChange,
  onSchemaFingerprintChange,
  onPartialExecutionTargetsChange,
}: ComfyWorkflowEditorProps) {
  const { t } = useTranslation("media");
  const entry = useComfySchemaStore((state) => (providerId ? state.entries[providerId] : undefined));
  const loadSchema = useComfySchemaStore((state) => state.load);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState<ComfyNodeBranch | "all">("all");
  const [partialExecutionTargets, setPartialExecutionTargets] = useState<string[]>([]);
  const initialFingerprint = useRef<string | null>(null);

  useEffect(() => {
    initialFingerprint.current = null;
    setSelectedNodeId(null);
    setBranchFilter("all");
    setPartialExecutionTargets([]);
  }, [providerId]);

  useEffect(() => {
    if (!providerId) {
      onSchemaFingerprintChange?.(null);
      return;
    }
    void loadSchema(providerId);
  }, [loadSchema, onSchemaFingerprintChange, providerId]);

  useEffect(() => {
    const fingerprint = entry?.data?.schemaFingerprint ?? null;
    onSchemaFingerprintChange?.(fingerprint);
    if (fingerprint && !initialFingerprint.current) initialFingerprint.current = fingerprint;
  }, [entry?.data?.schemaFingerprint, onSchemaFingerprintChange]);

  const parsed = useMemo(() => {
    if (!value.trim()) return { workflow: undefined, error: undefined };
    try {
      return parseComfyWorkflow(JSON.parse(value));
    } catch {
      return { workflow: undefined, error: "invalid" as const };
    }
  }, [value]);

  const workflow = parsed.workflow;
  const nodeEntries = useMemo(() => Object.entries(workflow ?? {}), [workflow]);
  const branchSummary = useMemo(() => {
    const schema = entry?.data?.schema ?? {};
    return BRANCHES.map((branch) => ({
      branch,
      available: Object.entries(schema).filter(([classType, definition]) => classifyComfyNode(classType, definition) === branch).length,
      active: nodeEntries.filter(([, node]) => classifyComfyNode(node.class_type, schema[node.class_type]) === branch).length,
    }));
  }, [entry?.data?.schema, nodeEntries]);
  const filteredNodeEntries = useMemo(
    () => branchFilter === "all"
      ? nodeEntries
      : nodeEntries.filter(([, node]) => classifyComfyNode(node.class_type, entry?.data?.schema?.[node.class_type]) === branchFilter),
    [branchFilter, entry?.data?.schema, nodeEntries],
  );
  const outputNodeEntries = useMemo(
    () => nodeEntries.filter(([, node]) => isOutputNode(node, entry?.data?.schema?.[node.class_type])),
    [entry?.data?.schema, nodeEntries],
  );
  useEffect(() => {
    const outputIds = new Set(outputNodeEntries.map(([nodeId]) => nodeId));
    setPartialExecutionTargets((current) => current.filter((nodeId) => outputIds.has(nodeId)));
  }, [outputNodeEntries]);
  useEffect(() => {
    onPartialExecutionTargetsChange?.(partialExecutionTargets);
  }, [onPartialExecutionTargetsChange, partialExecutionTargets]);
  const effectiveNodeId = selectedNodeId && filteredNodeEntries.some(([nodeId]) => nodeId === selectedNodeId)
    ? selectedNodeId
    : filteredNodeEntries[0]?.[0] ?? null;
  const selectedNode = effectiveNodeId ? workflow?.[effectiveNodeId] : undefined;
  const selectedDefinition = selectedNode && entry?.data?.schema
    ? entry.data.schema[selectedNode.class_type]
    : undefined;
  const inputDescriptors = useMemo(() => descriptors(selectedDefinition), [selectedDefinition]);
  const unknownClasses = useMemo(() => nodeEntries
    .map(([, node]) => node.class_type)
    .filter((classType, index, all) => all.indexOf(classType) === index && !entry?.data?.schema?.[classType]), [entry?.data?.schema, nodeEntries]);
  const schemaChanged = Boolean(
    initialFingerprint.current
      && entry?.data?.schemaFingerprint
      && initialFingerprint.current !== entry.data.schemaFingerprint,
  );

  function branchLabel(branch: ComfyNodeBranch): string {
    if (branch === "lora") return t("comfyBranchLora");
    if (branch === "controlnet") return t("comfyBranchControlNet");
    return t("comfyBranchIpAdapter");
  }

  function refreshSchema() {
    if (providerId) void loadSchema(providerId, true);
  }

  function updateInput(name: string, nextValue: unknown) {
    if (!workflow || !effectiveNodeId) return;
    const next = cloneWorkflow(workflow);
    const node = next[effectiveNodeId] as ComfyWorkflowNode;
    node.inputs = { ...node.inputs, [name]: nextValue };
    onChange(JSON.stringify(next, null, 2));
  }

  function canBindReference(type: string): boolean {
    return referenceCount > 0 && ["IMAGE", "VIDEO", "MASK"].includes(type);
  }

  function clearInput(name: string) {
    if (!workflow || !effectiveNodeId) return;
    const next = cloneWorkflow(workflow);
    const node = next[effectiveNodeId] as ComfyWorkflowNode;
    const inputs = { ...node.inputs };
    delete inputs[name];
    node.inputs = inputs;
    onChange(JSON.stringify(next, null, 2));
  }

  function togglePartialTarget(nodeId: string, checked: boolean) {
    setPartialExecutionTargets((current) => {
      const selected = new Set(current);
      if (checked) selected.add(nodeId);
      else selected.delete(nodeId);
      const next = [...selected].filter((id) => outputNodeEntries.some(([candidate]) => candidate === id));
      return next.length === outputNodeEntries.length ? [] : next;
    });
  }

  function renderReferenceControl(name: string, type: string, current: unknown) {
    const boundIndex = inputPlaceholderIndex(current);
    if (boundIndex !== null) {
      return (
        <div className="flex min-w-0 items-center gap-1">
          {referenceCount > 0 && boundIndex < referenceCount ? (
            <Select
              value={`reference-${boundIndex}`}
              onValueChange={(next) => updateInput(name, `{{input:${Number(next.slice("reference-".length))}}}`)}
            >
              <SelectTrigger size="sm" aria-label={t("comfyReferenceSelection")} className="max-w-44"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from({ length: referenceCount }, (_, index) => <SelectItem key={`reference-${index}`} value={`reference-${index}`}>{`#${index + 1} ${referenceNames[index] || t("comfyReferenceNumber", { index: index + 1 })}`}</SelectItem>)}</SelectContent>
            </Select>
          ) : <span className="max-w-36 truncate text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("comfyReferenceMissing")}</span>}
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => clearInput(name)} aria-label={t("comfyUnbindReference")} title={t("comfyUnbindReference")}><Unlink aria-hidden="true" /></Button>
        </div>
      );
    }
    if (!canBindReference(type)) return null;
    return <Button type="button" variant="ghost" size="xs" onClick={() => updateInput(name, "{{input:0}}")}><Link2 aria-hidden="true" />{t("comfyBindReference")}</Button>;
  }

  function renderInput(descriptor: InputDescriptor) {
    const spec = descriptor.spec;
    const type = inputType(spec);
    const opts = options(spec);
    const current = selectedNode?.inputs?.[descriptor.name];
    const linked = isLink(current);
    const label = `${displayName(descriptor.name, spec)}${descriptor.required ? " *" : ""}`;
    if (linked) {
      return (
        <div key={descriptor.name} className="space-y-1.5">
          <Label className="text-[11px]">{label}</Label>
          <div className="flex min-h-8 items-center justify-between gap-2 rounded-md border border-[var(--app-border)] px-2 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
            <span className="truncate">{t("comfyLinkedInput", { value: JSON.stringify(current) })}</span>
          </div>
        </div>
      );
    }
    const availableChoices = choices(spec);
    if (availableChoices && availableChoices.length > 0 && availableChoices.length <= 128) {
      const currentValue = valueForInput(current, spec);
      const selectedIndex = Math.max(0, availableChoices.findIndex((choice) => String(choice) === currentValue));
      return (
        <div key={descriptor.name} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2"><Label className="text-[11px]" title={typeof opts.tooltip === "string" ? opts.tooltip : undefined}>{label}</Label>{renderReferenceControl(descriptor.name, type, current)}</div>
          <Select value={`choice-${selectedIndex}`} onValueChange={(next) => updateInput(descriptor.name, availableChoices[Number(next.slice("choice-".length))])}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>{availableChoices.map((choice, index) => <SelectItem key={`choice-${index}`} value={`choice-${index}`}>{String(choice)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      );
    }
    if (type === "BOOLEAN") {
      const checked = current === undefined ? Boolean(opts.default) : current === true;
      return (
        <label key={descriptor.name} className="flex min-h-8 items-center gap-2 text-[11px]" style={{ color: "var(--app-text-secondary)" }} title={typeof opts.tooltip === "string" ? opts.tooltip : undefined}>
          <input type="checkbox" checked={checked} onChange={(event) => updateInput(descriptor.name, event.target.checked)} />
          {label}
        </label>
      );
    }
    const min = typeof opts.min === "number" ? opts.min : undefined;
    const max = typeof opts.max === "number" ? opts.max : undefined;
    const step = typeof opts.step === "number" ? opts.step : type === "INT" ? 1 : type === "FLOAT" ? 0.01 : undefined;
    if (type === "INT" || type === "FLOAT") {
      return (
        <div key={descriptor.name} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2"><Label className="text-[11px]" title={typeof opts.tooltip === "string" ? opts.tooltip : undefined}>{label}</Label>{renderReferenceControl(descriptor.name, type, current)}</div>
          <Input type="number" min={min} max={max} step={step} value={valueForInput(current, spec)} onChange={(event) => updateInput(descriptor.name, parseScalar(type, event.target.value))} />
        </div>
      );
    }
    const multiline = opts.multiline === true || opts.dynamicPrompts === true || type === "CUSTOM";
    return (
      <div key={descriptor.name} className="space-y-1.5">
        <div className="flex items-center justify-between gap-2"><Label className="text-[11px]" title={typeof opts.tooltip === "string" ? opts.tooltip : undefined}>{label}</Label>{renderReferenceControl(descriptor.name, type, current)}</div>
        {multiline
          ? <textarea value={valueForInput(current, spec)} onChange={(event) => updateInput(descriptor.name, event.target.value)} rows={3} className="w-full resize-y rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1.5 text-[11px] outline-none focus:border-[var(--app-accent)]" />
          : <Input value={valueForInput(current, spec)} onChange={(event) => updateInput(descriptor.name, event.target.value)} />}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-[var(--app-border)] p-2" data-testid="comfy-workflow-editor">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Braces className="size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
          <span className="text-[11px] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("comfyDynamicParameters")}</span>
          {entry?.data ? <span className="truncate text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfySchemaFingerprint", { fingerprint: formatFingerprint(entry.data.schemaFingerprint) })}</span> : null}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" disabled={!providerId || entry?.loading} onClick={refreshSchema} aria-label={t("refreshComfySchema")} title={t("refreshComfySchema")}>
          <RefreshCw className={entry?.loading ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </div>
      {showTemplateControls ? <ComfyWorkflowTemplateControls
        providerId={providerId}
        value={value}
        schemaFingerprint={entry?.data?.schemaFingerprint}
        onChange={onChange}
      /> : null}
      {entry?.error ? <p className="text-[10px]" style={{ color: "var(--app-status-danger)" }}>{t("comfySchemaLoadFailed", { message: entry.error })}</p> : null}
      {schemaChanged ? <p className="flex items-start gap-1 text-[10px]" style={{ color: "var(--app-status-warning)" }}><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />{t("comfySchemaChanged")}</p> : null}
      {parsed.error === "ui_format" ? <p className="text-[10px]" style={{ color: "var(--app-status-danger)" }}>{t("comfyUiWorkflowUnsupported")}</p> : null}
      {parsed.error === "invalid" ? <p className="text-[10px]" style={{ color: "var(--app-status-danger)" }}>{t("comfyWorkflowInvalid")}</p> : null}
      {workflow && nodeEntries.length > 0 ? <>
        {entry?.data && branchSummary.some(({ available, active }) => available > 0 || active > 0) ? <div className="space-y-1.5 rounded border border-[var(--app-border)] px-2 py-1.5" data-testid="comfy-branch-discovery">
          <div className="flex items-center justify-between gap-2"><Label className="text-[11px]">{t("comfyBranchFilter")}</Label><span className="text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyBranchHint")}</span></div>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("comfyBranchFilter")}>
            <button type="button" className="rounded border px-1.5 py-1 text-[10px]" aria-pressed={branchFilter === "all"} style={{ color: branchFilter === "all" ? "var(--app-accent)" : "var(--app-text-secondary)", borderColor: branchFilter === "all" ? "var(--app-accent)" : "var(--app-border)" }} onClick={() => setBranchFilter("all")}>{t("comfyBranchAll")} <span className="tabular-nums">{nodeEntries.length}</span></button>
            {branchSummary.filter(({ available, active }) => available > 0 || active > 0).map(({ branch, available, active }) => <button type="button" key={branch} className="rounded border px-1.5 py-1 text-[10px]" aria-pressed={branchFilter === branch} style={{ color: branchFilter === branch ? "var(--app-accent)" : "var(--app-text-secondary)", borderColor: branchFilter === branch ? "var(--app-accent)" : "var(--app-border)" }} onClick={() => setBranchFilter(branch)}>{branchLabel(branch)} <span className="tabular-nums">{active}/{available}</span></button>)}
          </div>
        </div> : null}
        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("comfyNode")}</Label>
          <Select value={effectiveNodeId ?? "__none__"} onValueChange={(next) => setSelectedNodeId(next === "__none__" ? null : next)}>
            <SelectTrigger size="sm" aria-label={t("comfyNode")}><SelectValue placeholder={t("comfySelectNode")} /></SelectTrigger>
            <SelectContent>{filteredNodeEntries.map(([nodeId, node]) => {
              const branch = classifyComfyNode(node.class_type, entry?.data?.schema?.[node.class_type]);
              return <SelectItem key={nodeId} value={nodeId}>{nodeId} · {entry?.data?.schema?.[node.class_type]?.display_name || node.class_type}{branch ? ` · ${branchLabel(branch)}` : ""}</SelectItem>;
            })}</SelectContent>
          </Select>
          {filteredNodeEntries.length === 0 ? <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyBranchNoNodes")}</p> : null}
        </div>
        {outputNodeEntries.length > 0 ? <div className="space-y-1.5 rounded border border-[var(--app-border)] px-2 py-1.5">
          <div className="flex items-center justify-between gap-2"><Label className="text-[11px]">{t("comfyExecutionTargets")}</Label><span className="text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyExecutionTargetsHint")}</span></div>
          <label className="flex items-center gap-2 text-[10px]" style={{ color: "var(--app-text-secondary)" }}><input type="checkbox" checked={partialExecutionTargets.length === 0} onChange={() => setPartialExecutionTargets([])} />{t("comfyAllOutputs")}</label>
          <div className="grid grid-cols-1 gap-1">
            {outputNodeEntries.map(([nodeId, node]) => <label key={nodeId} className="flex min-w-0 items-center gap-2 text-[10px]" style={{ color: "var(--app-text-secondary)" }}><input type="checkbox" checked={partialExecutionTargets.length === 0 || partialExecutionTargets.includes(nodeId)} onChange={(event) => togglePartialTarget(nodeId, event.target.checked)} /><span className="truncate">{nodeId} · {entry?.data?.schema?.[node.class_type]?.display_name || node.class_type}</span></label>)}
          </div>
        </div> : null}
        {unknownClasses.length > 0 ? <p className="text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("comfyUnknownNodes", { nodes: unknownClasses.join(", ") })}</p> : null}
        {selectedDefinition && inputDescriptors.length > 0 ? <div className="grid grid-cols-1 gap-2">{inputDescriptors.map(renderInput)}</div> : <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyRawJsonFallback")}</p>}
      </> : <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyDynamicParametersHint")}</p>}
      {entry?.data ? <p className="text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfySchemaVersion", { version: entry.data.schemaVersion })}</p> : null}
    </div>
  );
}
