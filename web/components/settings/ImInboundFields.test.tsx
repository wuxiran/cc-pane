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

import ImInboundFields, { parseUserIds } from "./ImInboundFields";

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

  it("parses allowed user ids and saves them on blur", () => {
    expect(parseUserIds(" 11, 22，33  -100 @name abc")).toEqual(["11", "22", "33", "-100"]);
    const onChange = vi.fn();
    render(<ImInboundFields channel={{ ...channel, inboundEnabled: true }} onChange={onChange} />);
    const input = screen.getByLabelText("imInboundAllowedUsers");
    fireEvent.change(input, { target: { value: "11, @someone 22" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ inboundAllowedUserIds: ["11", "22"] });
  });

  it("warns that @username chat ids cannot receive messages", () => {
    render(<ImInboundFields channel={{ ...channel, chatId: "@me", inboundEnabled: true }} onChange={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("imInboundNeedsNumericChatId");
  });

  it("shows no warning for numeric chat ids", () => {
    render(<ImInboundFields channel={{ ...channel, inboundEnabled: true }} onChange={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
