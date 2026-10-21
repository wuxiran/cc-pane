import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { turnCheckpointService } from "./turnCheckpointService";
const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => runtime.desktop }));

beforeEach(() => { vi.clearAllMocks(); runtime.desktop = true; });

it("uses desktop checkpoint commands and sends the reviewed revision", async () => {
  await turnCheckpointService.list("chat-1");
  await turnCheckpointService.review("checkpoint-1");
  await turnCheckpointService.restore("checkpoint-1", "revision-1");
  expect(invoke).toHaveBeenNthCalledWith(1, "list_turn_checkpoints", { chatId: "chat-1" });
  expect(invoke).toHaveBeenNthCalledWith(2, "review_turn_checkpoint", { id: "checkpoint-1" });
  expect(invoke).toHaveBeenNthCalledWith(3, "restore_turn_checkpoint", { id: "checkpoint-1", revision: "revision-1" });
});

it("explicitly rejects unsupported web runtimes", async () => {
  runtime.desktop = false;
  await expect(turnCheckpointService.list("chat-1")).rejects.toThrow("desktop app");
  expect(invoke).not.toHaveBeenCalled();
});
