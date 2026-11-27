import { beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.fn();
const list = vi.fn();
const openBrowser = vi.fn();
const findTab = vi.fn();

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/portPreviewService", () => ({
  portPreviewService: {
    open: (...args: unknown[]) => open(...args),
    list: () => list(),
  },
}));
vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: {
    getState: () => ({ findTabBySessionAcrossLayouts: findTab, openBrowser }),
  },
}));

import { openPortPreview } from "./portPreviewActivation";
import { findLocalhostPreviewLinks } from "./localhostPreviewLink";

const ssh = { host: "devbox", port: 22, remotePath: "/srv" };

describe("openPortPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
  });

  it("按会话的 SSH 信息建隧道并在内置浏览器打开本机地址", async () => {
    findTab.mockReturnValue({ tab: { ssh } });
    open.mockResolvedValue({ id: "t1", localPort: 41000 });
    const [link] = findLocalhostPreviewLinks("Local: http://0.0.0.0:5173/app");
    const url = await openPortPreview("session-1", link);
    expect(open).toHaveBeenCalledWith({ sessionId: "session-1", ssh, remoteHost: "127.0.0.1", remotePort: 5173 });
    expect(url).toBe("http://127.0.0.1:41000/app");
    expect(openBrowser).toHaveBeenCalledWith(url, "devbox:5173");
  });

  it("非 SSH 会话不建隧道", async () => {
    findTab.mockReturnValue({ tab: {} });
    const [link] = findLocalhostPreviewLinks("localhost:3000");
    await expect(openPortPreview("session-1", link)).rejects.toThrow("panes:portPreview.notSsh");
    expect(open).not.toHaveBeenCalled();
  });
});
