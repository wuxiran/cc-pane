import type { AcpChatSnapshot } from "@/types/agentChat";
import { selectableConfigOptions } from "./ConfigOptionSelectors";

export interface ChatModeGroup {
  id: string;
  name?: string;
  current?: string;
  configId?: string;
  choices: { id: string; name: string; description?: string }[];
}

/** Prefer the advertised config API. Legacy modes are only a fallback, so the
 * same mode never appears twice and no provider-specific plan id is invented. */
export function chatModeGroups(snapshot?: AcpChatSnapshot | null): ChatModeGroup[] {
  const configModes = selectableConfigOptions(snapshot?.configOptions, new Set())
    .filter((option) => option.category === "mode");
  if (configModes.length > 0) return configModes.map((option) => ({
    id: option.configId,
    configId: option.configId,
    name: option.name,
    current: typeof option.currentValue === "string" ? option.currentValue : undefined,
    choices: (option.options ?? []).map((choice) => ({
      id: choice.value, name: choice.name || choice.value, description: choice.description,
    })),
  }));
  const modes = snapshot?.modes?.availableModes ?? [];
  return modes.length > 0 ? [{
    id: "legacy-mode",
    current: snapshot?.modes?.currentModeId,
    choices: modes.map((mode) => ({ id: mode.id, name: mode.name || mode.id, description: mode.description })),
  }] : [];
}
