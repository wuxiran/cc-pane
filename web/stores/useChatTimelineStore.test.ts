import { beforeEach, describe, expect, it } from "vitest";
import { useChatTimelineStore as store } from "./useChatTimelineStore";

beforeEach(() => {
  localStorage.removeItem("cc-panes-chat-timeline");
  store.setState({ bookmarks: {} });
});

describe("timeline bookmarks", () => {
  it("isolates conversations and removes empty bookmark sets", () => {
    store.getState().toggleBookmark("claude:one", "prompt");
    expect(store.getState().bookmarks["claude:two"]).toBeUndefined();
    store.getState().toggleBookmark("claude:two", "other");
    store.getState().toggleBookmark("claude:one", "prompt");
    expect(store.getState().bookmarks).toEqual({ "claude:two": ["other"] });
  });
  it("rehydrates saved marks after the UI is reopened", async () => {
    store.getState().toggleBookmark("codex:one", "user:hash:0");
    const saved = localStorage.getItem("cc-panes-chat-timeline")!;
    store.setState({ bookmarks: {} });
    localStorage.setItem("cc-panes-chat-timeline", saved);
    await store.persist.rehydrate();
    expect(store.getState().bookmarks).toEqual({ "codex:one": ["user:hash:0"] });
  });
});
