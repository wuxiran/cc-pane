import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotSummary } from "@/types/bot";

const setBotRemote = vi.fn();
const confirm = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/services/botMeshService", () => ({
  botMeshService: { setBotRemote: (...args: unknown[]) => setBotRemote(...args) },
}));
vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: (...args: unknown[]) => confirm(...args) }));

import RemotePolicyDialog from "./RemotePolicyDialog";

const bot: BotSummary = {
  id: "b1",
  name: "Rev",
  avatar: "",
  color: "",
  persona: "",
  engineId: "claude",
  autoApproveKinds: [],
  remoteShared: true,
  remotePolicy: "ask_origin",
  remoteAllowKinds: [],
  createdAt: 0,
  updatedAt: 0,
  chatId: "bot-b1",
  effectiveCwd: "/tmp",
};

describe("RemotePolicyDialog", () => {
  beforeEach(() => {
    setBotRemote.mockReset().mockResolvedValue({});
    confirm.mockReset();
  });

  it("offers four levels and saves allowlist kinds", async () => {
    const onSaved = vi.fn();
    render(<RemotePolicyDialog bot={bot} onClose={() => {}} onSaved={onSaved} />);
    for (const level of ["deny", "ask_origin", "allowlist", "full"]) {
      expect(screen.getByTestId(`remote-policy-${level}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId("remote-policy-allowlist"));
    fireEvent.click(screen.getByLabelText("bots.mesh.kind.read"));
    fireEvent.click(screen.getByText("bots.save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(setBotRemote).toHaveBeenCalledWith("b1", {
      remoteShared: true,
      remotePolicy: "allowlist",
      remoteAllowKinds: ["read"],
      confirmFull: false,
    });
  });

  it("full shows a red warning and needs an explicit confirm", async () => {
    render(<RemotePolicyDialog bot={bot} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByTestId("remote-policy-full"));
    expect(screen.getByRole("alert")).toHaveTextContent("bots.mesh.fullWarning");
    confirm.mockResolvedValue(false);
    fireEvent.click(screen.getByText("bots.save"));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(setBotRemote).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByText("bots.save"));
    await waitFor(() => expect(setBotRemote).toHaveBeenCalled());
    expect(setBotRemote.mock.calls[0][1]).toMatchObject({ remotePolicy: "full", confirmFull: true });
  });
});
