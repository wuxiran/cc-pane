import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { useMcpStore } from "@/stores/useMcpStore";
import { mcpTargetKey, type McpLayerTarget, type McpServerConfig } from "@/types";
import { formatEnvLines, parseEnvLines, translateError } from "@/utils";
import { formatArgumentText, parseArgumentText } from "@/utils/argumentText";

interface FormState {
  name: string;
  command: string;
  args: string;
  env: string;
  descriptionZh: string;
  descriptionEn: string;
}

const emptyForm: FormState = {
  name: "", command: "", args: "", env: "", descriptionZh: "", descriptionEn: "",
};

/** A form belongs to the layer that supplied its contents, including across async saves. */
export function useMcpServerEditor(target: McpLayerTarget) {
  const { t } = useTranslation("notifications");
  const targetKey = mcpTargetKey(target);
  const [editing, setEditing] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const parsedArgs = parseArgumentText(form.args);
  const argsError = parsedArgs.error ? t(parsedArgs.error === "nul" ? "mcpArgsNul" : "mcpArgsUnclosedQuote") : null;
  const owner = useRef<{ target: McpLayerTarget; version: number } | null>(null);
  const sequence = useRef(0);
  const saving = useRef(new Set<number>());

  const resetForm = useCallback((expectedTarget?: McpLayerTarget) => {
    if (expectedTarget && owner.current && mcpTargetKey(owner.current.target) !== mcpTargetKey(expectedTarget)) return;
    owner.current = null;
    setForm(emptyForm);
    setEditing(false);
    setEditingName(null);
  }, []);

  useEffect(() => {
    if (owner.current && mcpTargetKey(owner.current.target) !== targetKey) resetForm();
  }, [targetKey, resetForm]);

  const openForm = (name: string | null, next: FormState) => {
    owner.current = { target, version: ++sequence.current };
    setEditingName(name);
    setForm(next);
    setEditing(true);
  };

  const handleEdit = (name: string, config: McpServerConfig) => openForm(name, {
    name, command: config.command, args: formatArgumentText(config.args), env: formatEnvLines(config.env),
    descriptionZh: config.descriptions?.["zh-CN"] ?? "",
    descriptionEn: config.descriptions?.en ?? "",
  });

  const handleSave = async () => {
    const session = owner.current;
    if (!session || mcpTargetKey(session.target) !== targetKey || saving.current.has(session.version)) return;
    if (!form.name.trim() || !form.command.trim()) {
      toastErr(t("mcpNameCommandRequired"));
      return;
    }
    if (parsedArgs.error) { toastErr(argsError!); return; }
    saving.current.add(session.version);
    try {
      const store = useMcpStore.getState();
      if (editingName && editingName !== form.name.trim()) await store.removeServer(session.target, editingName);
      await store.upsertServer(session.target, form.name.trim(), form.command.trim(), parsedArgs.args, parseEnvLines(form.env), {
        "zh-CN": form.descriptionZh.trim(), en: form.descriptionEn.trim(),
      });
      toastOk(t(editingName ? "mcpServerUpdated" : "mcpServerAdded"));
      if (owner.current?.version === session.version) resetForm();
    } catch (error) {
      toastErr(t("operationFailed", { error: translateError(error) }));
    } finally {
      saving.current.delete(session.version);
    }
  };

  return {
    editing: editing && owner.current !== null && mcpTargetKey(owner.current.target) === targetKey,
    editingName, form, setForm, argsError, resetForm, handleEdit, handleSave,
    handleNew: () => openForm(null, { ...emptyForm }),
  };
}
