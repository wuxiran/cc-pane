import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AutomationDef, AutomationRun } from "@/types/automation";
import { AUTOMATIONS_CHANGED_EVENT } from "@/types/automation";

export async function listAutomations(): Promise<AutomationDef[]> {
  return invoke<AutomationDef[]>("list_automations");
}

export async function saveAutomation(def: AutomationDef): Promise<AutomationDef> {
  return invoke<AutomationDef>("save_automation", { def });
}

export async function deleteAutomation(automationId: string): Promise<void> {
  await invoke("delete_automation", { automationId });
}

export async function runAutomationNow(automationId: string): Promise<void> {
  await invoke("run_automation_now", { automationId });
}

export async function listAutomationRuns(automationId: string): Promise<AutomationRun[]> {
  return invoke<AutomationRun[]>("list_automation_runs", { automationId });
}

export async function listenAutomationsChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(AUTOMATIONS_CHANGED_EVENT, handler);
}

export const automationService = {
  listAutomations,
  saveAutomation,
  deleteAutomation,
  runAutomationNow,
  listAutomationRuns,
  listenAutomationsChanged,
};
