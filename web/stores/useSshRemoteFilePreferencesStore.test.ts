import { beforeEach, describe, expect, it } from "vitest";
import { useSshRemoteFilePreferencesStore } from "./useSshRemoteFilePreferencesStore";

describe("useSshRemoteFilePreferencesStore", () => {
  beforeEach(() => {
    useSshRemoteFilePreferencesStore.setState({
      viewMode: "tree",
      sortKey: "name",
      sortDirection: "asc",
      bookmarks: {},
    });
  });

  it("toggles sorting direction and remembers server bookmarks", () => {
    const store = useSshRemoteFilePreferencesStore.getState();
    store.setSort("name");
    expect(useSshRemoteFilePreferencesStore.getState().sortDirection).toBe("desc");

    store.toggleBookmark("m-1", "/srv/app");
    expect(useSshRemoteFilePreferencesStore.getState().bookmarks).toEqual({
      "m-1": ["/srv/app"],
    });
    store.toggleBookmark("m-1", "/srv/app");
    expect(useSshRemoteFilePreferencesStore.getState().bookmarks).toEqual({
      "m-1": [],
    });
  });

  it("uses the same tree-first layout as the Files tab", () => {
    expect(useSshRemoteFilePreferencesStore.getState().viewMode).toBe("tree");
  });
});
