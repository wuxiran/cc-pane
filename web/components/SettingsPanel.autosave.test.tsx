import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { AppSettings } from "@/types";
import type { CCChanSettings } from "@/ccchan/types";
import { useSettingsStore } from "@/stores";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { toastErr } from "@/lib/feedback";
import { createSettingsDraft, type SettingsDraft } from "./settings/settingsDraft";
import WebAccessSection from "./settings/WebAccessSection";
import SettingsPanel from "./SettingsPanel";

const io = vi.hoisted(() => ({
  pane: null as null | { draft: SettingsDraft; updateDraft: (draft: SettingsDraft) => void },
  disk: null as AppSettings | null,
  write: vi.fn<(value: AppSettings) => Promise<void>>(),
  companion: vi.fn<(value: CCChanSettings) => Promise<void>>(),
}));
vi.mock("@/services/settingsService", () => ({ settingsService: {
  updateSettings: io.write,
  getSettings: async () => structuredClone(io.disk),
  setWebAccessPassword: async () => {
    io.disk!.webAccess.passwordHash = null;
    io.disk!.webAccess.passwordSalt = null;
  },
  getWebAccessStatus: async () => ({ running: false, passwordConfigured: Boolean(io.disk?.webAccess.passwordHash) }),
} }));
vi.mock("./settings/SettingsPaneContent", () => ({
  default: (props: NonNullable<typeof io.pane>) => {
    io.pane = props;
    return <WebAccessSection value={props.draft.webAccess} onChange={(webAccess) => props.updateDraft({ ...props.draft, webAccess })} />;
  },
}));
vi.mock("@/lib/feedback", () => ({ toastOk: vi.fn(), toastErr: vi.fn(), toastInfo: vi.fn() }));

function change(patch: (draft: SettingsDraft) => SettingsDraft) {
  act(() => io.pane!.updateDraft(patch(io.pane!.draft)));
}

function close() {
  fireEvent.click(screen.getAllByRole("button", { name: i18n.t("common:close") }).slice(-1)[0]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.disk = useSettingsStore.getState().getDefaults();
  io.disk.webAccess.passwordHash = "old-hash";
  io.disk.webAccess.passwordSalt = "old-salt";
  io.write.mockImplementation(async (value) => { io.disk = structuredClone(value); });
  useSettingsStore.setState({ settings: structuredClone(io.disk) });
  useCCChanStore.setState({ loaded: true, settings: createSettingsDraft(io.disk).ccchan, saveSettings: io.companion });
  io.companion.mockImplementation(async (value) => { useCCChanStore.setState({ settings: value }); });
});

describe("settings autosave ownership and ordering", () => {
  it("keeps an explicitly cleared Web password null after another field autosaves", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    change((draft) => ({ ...draft, general: { ...draft.general, language: "en" } }));
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings:webAccessSection.savePassword") }));
    await waitFor(() => expect(useSettingsStore.getState().settings!.webAccess.passwordHash).toBeNull());
    change((draft) => ({ ...draft, general: { ...draft.general, language: "zh-CN" } }));
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    expect(io.disk!.webAccess.passwordHash).toBeNull();
    expect(io.disk!.webAccess.passwordSalt).toBeNull();
    expect(io.pane!.draft.webAccess.passwordHash).toBeNull();
    expect(io.companion).not.toHaveBeenCalled();
  });

  it("rebases pending fields over unrelated live updates including fields in the same section", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    change((draft) => ({ ...draft, general: { ...draft.general, language: "en" } }));
    await act(async () => {
      const live = useSettingsStore.getState().settings!;
      await useSettingsStore.getState().saveSettings({
        ...live, general: { ...live.general, defaultCliTool: "gemini" }, tips: { ...live.tips, tried: ["file-editor"] },
      });
    });
    expect(io.pane!.draft.general.language).toBe("en");
    expect(io.pane!.draft.general.defaultCliTool).toBe("gemini");
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    expect(io.disk!.general).toMatchObject({ language: "en", defaultCliTool: "gemini" });
    expect(io.disk!.tips.tried).toEqual(["file-editor"]);
    act(() => useSettingsStore.setState({ settings: { ...io.disk!, tips: { ...io.disk!.tips, tried: ["later-update"] } } }));
    expect(io.pane!.draft.tips.tried).toEqual(["later-update"]);
  });

  it("serializes saves and close waits for an edit reverted while the first save is in flight", async () => {
    const first = deferred();
    io.write.mockImplementationOnce(async (value) => { await first.promise; io.disk = structuredClone(value); });
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);
    const original = io.pane!.draft.general.language;
    change((draft) => ({ ...draft, general: { ...draft.general, language: "en" } }));
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    change((draft) => ({ ...draft, general: { ...draft.general, language: original } }));
    close();
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => { first.resolve(); });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(io.write).toHaveBeenCalledTimes(2);
    expect(io.write.mock.calls.map(([settings]) => settings.general.language)).toEqual(["en", original]);
    expect(io.disk!.general.language).toBe(original);
  });

  it("keeps a failed close flush open with its draft and retries all pending fields", async () => {
    io.write.mockRejectedValueOnce(new Error("disk full"));
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);
    change((draft) => ({ ...draft, general: { ...draft.general, language: "en" } }));
    close();
    await waitFor(() => expect(toastErr).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(io.pane!.draft.general.language).toBe("en");
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("common:keepEditing") }));
    change((draft) => ({ ...draft, general: { ...draft.general, defaultCliTool: "gemini" } }));
    close();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(io.disk!.general).toMatchObject({ language: "en", defaultCliTool: "gemini" });
  });

  it("offers cancel or explicit discard when persistent save failure prevents closing", async () => {
    io.write.mockRejectedValue(new Error("disk remains full"));
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);
    change((draft) => ({ ...draft, general: { ...draft.general, language: "en" } }));
    close();
    const discardName = i18n.t("common:discardChanges");
    await screen.findByRole("button", { name: discardName });
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("common:keepEditing") }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(io.pane!.draft.general.language).toBe("en");
    close();
    fireEvent.click(await screen.findByRole("button", { name: discardName }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(io.pane!.draft.general.language).toBe(io.disk!.general.language);
  });

  it("reads live cleared credentials and companion state after waiting for companion I/O", async () => {
    const gate = deferred();
    io.companion.mockImplementation(async (value) => {
      await gate.promise;
      useCCChanStore.setState({ settings: { ...value, windowX: useCCChanStore.getState().settings.windowX } });
    });
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    change((draft) => ({ ...draft, ccchan: { ...draft.ccchan, petSize: 180 } }));
    await waitFor(() => expect(io.companion).toHaveBeenCalledTimes(1));
    expect(io.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings:webAccessSection.savePassword") }));
    await waitFor(() => expect(useSettingsStore.getState().settings!.webAccess.passwordHash).toBeNull());
    act(() => useCCChanStore.setState({ settings: { ...useCCChanStore.getState().settings, windowX: 900 } }));
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    const saved = createSettingsDraft(io.write.mock.calls[0][0]);
    expect(saved.webAccess.passwordHash).toBeNull();
    expect(saved.webAccess.passwordSalt).toBeNull();
    expect(saved.ccchan).toMatchObject({ petSize: 180, windowX: 900 });
  });
});
