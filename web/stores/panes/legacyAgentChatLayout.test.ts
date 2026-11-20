import { describe, expect, it } from "vitest";
import { createPanel, generateId } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";
import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { usePanesStore } from "../usePanesStore";
import type { PanesState } from "../panesStoreTypes";
import { isBlankAgentChatTab, LEGACY_AGENT_CHAT_LAYOUT_ID } from "./legacyAgentChatLayout";

function layout(id: string, rootPane: PaneNode, name = id): LayoutEntry {
  const first = rootPane.type === "panel" ? rootPane.id : (rootPane.children[0]?.id ?? rootPane.id);
  return { id, name, kind: "normal", rootPane, activePaneId: first };
}

function legacy(rootPane: PaneNode): LayoutEntry {
  return layout(LEGACY_AGENT_CHAT_LAYOUT_ID, rootPane, "Agent Chat");
}

function starred(): LayoutEntry {
  const root = createPanel();
  return { id: "starred", name: "★", kind: "starred", rootPane: root, activePaneId: root.id };
}

function panelOf(...tabs: Tab[]): PaneNode {
  const panel = createPanel(tabs[0]);
  panel.tabs = tabs;
  panel.activeTabId = tabs[0]?.id ?? panel.activeTabId;
  return panel;
}

const blankChat = (): Tab => createTabOfType("agent-chat", { projectPath: "" });

/** 走真实 rehydrate 链路：persist.migrate(v5) → merge。 */
function rehydrateV5(layouts: LayoutEntry[], currentLayoutId: string): PanesState {
  const options = usePanesStore.persist.getOptions();
  const migrated = options.migrate!(JSON.parse(JSON.stringify({ layouts, currentLayoutId })), 5);
  return options.merge!(migrated, usePanesStore.getState()) as PanesState;
}

function normalIds(state: PanesState): string[] {
  return state.layouts.filter((item) => item.kind !== "starred").map((item) => item.id);
}

describe("isBlankAgentChatTab", () => {
  it("only an untouched agent-chat tab is blank", () => {
    expect(isBlankAgentChatTab(blankChat())).toBe(true);
    expect(isBlankAgentChatTab(createTabOfType("agent-chat", { projectPath: "/repo" }))).toBe(false);
    expect(isBlankAgentChatTab(createTabOfType("agent-chat", { agentEngineId: "codex" }))).toBe(false);
    expect(isBlankAgentChatTab(createTabOfType("agent-chat", { parentTabId: "tab-parent" }))).toBe(false);
    expect(isBlankAgentChatTab(createTabOfType("agent-chat", { title: "Bot" }))).toBe(false);
    expect(isBlankAgentChatTab(createTabOfType("browser", { browserUrl: "https://example.com" }))).toBe(false);
  });
});

describe("v6 migration of the legacy Agent Chat layout", () => {
  it("drops a layout that only holds one blank new chat", () => {
    const cli = layout("cli", createPanel());
    const state = rehydrateV5([cli, starred(), legacy(createPanel(blankChat()))], "cli");
    expect(normalIds(state)).toEqual(["cli"]);
    expect(state.currentLayoutId).toBe("cli");
  });

  it("keeps a layout with a real conversation as an ordinary layout", () => {
    const cli = layout("cli", createPanel());
    const chat = createTabOfType("agent-chat", { projectPath: "/repo", agentEngineId: "codex" });
    const state = rehydrateV5([cli, starred(), legacy(createPanel(chat))], "cli");
    expect(normalIds(state)).toEqual(["cli", LEGACY_AGENT_CHAT_LAYOUT_ID]);
    const kept = state.layouts.find((item) => item.id === LEGACY_AGENT_CHAT_LAYOUT_ID)!;
    expect(kept.name).toBe("Agent Chat");
    expect(kept.kind).toBe("normal");
    const tabs = kept.rootPane.type === "panel" ? kept.rootPane.tabs : [];
    expect(tabs.map((tab) => tab.id)).toEqual([chat.id]);
  });

  it("keeps a split layout even when every pane only has a blank chat", () => {
    const cli = layout("cli", createPanel());
    const split: PaneNode = { type: "split", id: generateId("split"), direction: "horizontal", children: [createPanel(blankChat()), createPanel(blankChat())], sizes: [50, 50] };
    const state = rehydrateV5([cli, starred(), legacy(split)], "cli");
    expect(normalIds(state)).toContain(LEGACY_AGENT_CHAT_LAYOUT_ID);
  });

  it("drops a layout whose single pane has no tabs at all", () => {
    const cli = layout("cli", createPanel());
    const state = rehydrateV5([cli, starred(), legacy(panelOf())], "cli");
    expect(normalIds(state)).toEqual(["cli"]);
  });

  it("keeps a single pane holding a blank chat plus a file tab", () => {
    const cli = layout("cli", createPanel());
    const editor = createTabOfType("editor", { filePath: "/repo/a.ts", projectPath: "/repo" });
    const state = rehydrateV5([cli, starred(), legacy(panelOf(blankChat(), editor))], "cli");
    expect(normalIds(state)).toContain(LEGACY_AGENT_CHAT_LAYOUT_ID);
  });

  it("repoints currentLayoutId when the dropped layout was current", () => {
    const cliRoot = createPanel();
    const cli = layout("cli", cliRoot);
    const state = rehydrateV5([cli, starred(), legacy(createPanel(blankChat()))], LEGACY_AGENT_CHAT_LAYOUT_ID);
    expect(state.currentLayoutId).toBe("cli");
    expect(state.rootPane.id).toBe(cliRoot.id);
  });

  it("stays current when the kept layout was current", () => {
    const cli = layout("cli", createPanel());
    const chat = createTabOfType("agent-chat", { projectPath: "/repo" });
    const state = rehydrateV5([cli, starred(), legacy(createPanel(chat))], LEGACY_AGENT_CHAT_LAYOUT_ID);
    expect(state.currentLayoutId).toBe(LEGACY_AGENT_CHAT_LAYOUT_ID);
  });

  it("still leaves one ordinary layout when the dropped layout was the only one", () => {
    const state = rehydrateV5([starred(), legacy(createPanel(blankChat()))], LEGACY_AGENT_CHAT_LAYOUT_ID);
    const ids = normalIds(state);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(LEGACY_AGENT_CHAT_LAYOUT_ID);
    expect(state.currentLayoutId).toBe(ids[0]);
  });

  it("keeps the only layout when it holds real tabs", () => {
    const chat = createTabOfType("agent-chat", { projectPath: "/repo" });
    const state = rehydrateV5([starred(), legacy(createPanel(chat))], LEGACY_AGENT_CHAT_LAYOUT_ID);
    expect(normalIds(state)).toEqual([LEGACY_AGENT_CHAT_LAYOUT_ID]);
    expect(state.currentLayoutId).toBe(LEGACY_AGENT_CHAT_LAYOUT_ID);
  });

  it("no longer sweeps agent-chat tabs out of other layouts", () => {
    const chat = createTabOfType("agent-chat", { projectPath: "/repo" });
    const cli = layout("cli", createPanel(chat));
    const state = rehydrateV5([cli, starred()], "cli");
    const tabs = state.rootPane.type === "panel" ? state.rootPane.tabs : [];
    expect(tabs.map((tab) => tab.id)).toEqual([chat.id]);
  });

  it("a v6 snapshot is left alone: the legacy id is now just an ordinary layout", () => {
    const cli = layout("cli", createPanel());
    const options = usePanesStore.persist.getOptions();
    const snapshot = { layouts: [cli, starred(), legacy(createPanel(blankChat()))], currentLayoutId: "cli" };
    const migrated = options.migrate!(JSON.parse(JSON.stringify(snapshot)), 6);
    const state = options.merge!(migrated, usePanesStore.getState()) as PanesState;
    expect(normalIds(state)).toEqual(["cli", LEGACY_AGENT_CHAT_LAYOUT_ID]);
  });
});
