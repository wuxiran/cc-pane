import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImChannelConfig } from "@/types";

const confirm = vi.fn();
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: (...args: unknown[]) => confirm(...args) }));
vi.mock("@/services/botService", () => ({
  botService: {
    list: vi.fn(async () => [{ id: "b1", name: "周报", avatar: "📝" }]),
  },
}));

import ImInboundFields from "./ImInboundFields";

const channel: ImChannelConfig = {
  id: "c1",
  channelType: "telegram",
  name: "tg",
  url: "",
  token: "t",
  secret: null,
  chatId: "1",
  events: [],
  enabled: true,
};

describe("ImInboundFields", () => {
  it("asks for confirmation before enabling inbound", async () => {
    const onChange = vi.fn();
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ImInboundFields channel={channel} onChange={onChange} />);
    const box = screen.getByRole("checkbox");
    fireEvent.click(box);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(box);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ inboundEnabled: true }));
  });

  it("turns off without confirmation and lists bots as default targets when on", async () => {
    const onChange = vi.fn();
    confirm.mockClear();
    render(<ImInboundFields channel={{ ...channel, inboundEnabled: true }} onChange={onChange} />);
    expect(await screen.findByRole("option", { name: "📝 周报" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b1" } });
    expect(onChange).toHaveBeenCalledWith({ defaultBotId: "b1" });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ inboundEnabled: false }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
