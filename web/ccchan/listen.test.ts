import { getCurrentWebview } from "@tauri-apps/api/webview";
import { expect, it, vi } from "vitest";
import { listenCCChan } from "./listen";
it("releases late subscriptions and ignores callbacks after disposal", async () => {
  const handler = vi.fn(); const unlisten = vi.fn();
  let resolve!: (fn: () => void) => void;
  let callback!: (event: unknown) => void;
  vi.mocked(getCurrentWebview().listen).mockImplementation((_name, fn) => {
    callback = fn as (event: unknown) => void;
    return new Promise((r) => { resolve = r; });
  });
  const dispose = listenCCChan("probe", handler);
  dispose();
  callback({ payload: "late" });
  resolve(unlisten);
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
});
