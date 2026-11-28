import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
const close = vi.fn();
vi.mock("@/services/portPreviewService", () => ({
  portPreviewService: { list: () => list(), close: (id: string) => close(id) },
}));

import { usePortPreviewStore } from "./usePortPreviewStore";

const tunnel = (id: string) => ({
  id, sessionId: "s1", sshHost: "devbox", remoteHost: "localhost", remotePort: 3000, localPort: 3000, createdAt: 1,
});

describe("usePortPreviewStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePortPreviewStore.setState({ tunnels: [] });
  });

  it("refresh 拉取列表，异常返回值按空处理", async () => {
    list.mockResolvedValueOnce([tunnel("a")]);
    await usePortPreviewStore.getState().refresh();
    expect(usePortPreviewStore.getState().tunnels.map((item) => item.id)).toEqual(["a"]);
    list.mockResolvedValueOnce(undefined);
    await usePortPreviewStore.getState().refresh();
    expect(usePortPreviewStore.getState().tunnels).toEqual([]);
  });

  it("close 关闭后与后端重新同步", async () => {
    usePortPreviewStore.setState({ tunnels: [tunnel("a"), tunnel("b")] });
    close.mockResolvedValue(true);
    list.mockResolvedValue([tunnel("b")]);
    await usePortPreviewStore.getState().close("a");
    expect(close).toHaveBeenCalledWith("a");
    expect(usePortPreviewStore.getState().tunnels.map((item) => item.id)).toEqual(["b"]);
  });
});
