import { getCurrentWindowIfTauri } from "./runtime";

export async function startBrowserWindowDrag(): Promise<void> {
  const window = getCurrentWindowIfTauri();
  if (!window) throw new Error("Browser windows require the desktop app");
  await window.startDragging();
}
