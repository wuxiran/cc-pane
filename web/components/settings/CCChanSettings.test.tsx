import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_PET, useCCChanStore } from "@/stores/useCCChanStore";
import type { CCChanSettings as CCChanSettingsValue } from "@/ccchan/types";
import CCChanSettings from "./CCChanSettings";

function createValue(overrides: Partial<CCChanSettingsValue> = {}): CCChanSettingsValue {
  return {
    aiEngine: "claude",
    defaultPetId: FALLBACK_PET.id,
    autoStart: false,
    soundEnabled: true,
    windowVisible: true,
    windowX: 100,
    windowY: 200,
    wanderEnabled: false,
    petSize: 120,
    ...overrides,
  } as CCChanSettingsValue;
}

const loadMock = vi.fn(async () => {});

describe("CCChanSettings", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
    useCCChanStore.setState({ pets: [FALLBACK_PET], load: loadMock });
  });

  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("loads pets from the store on mount", () => {
    render(<CCChanSettings value={createValue()} onChange={vi.fn()} />);

    expect(loadMock).toHaveBeenCalled();
  });

  it("switches the AI engine and highlights the active option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CCChanSettings value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Codex" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ aiEngine: "codex" }));
  });

  it("lists store pets in the role select and emits selection changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    useCCChanStore.setState({
      pets: [
        FALLBACK_PET,
        { ...FALLBACK_PET, id: "neko", displayName: "Neko", description: "猫猫" },
      ],
      load: loadMock,
    });
    render(<CCChanSettings value={createValue()} onChange={onChange} />);

    const select = screen.getByRole("combobox");
    await user.click(select);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.click(screen.getByRole("option", { name: "Neko" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ defaultPetId: "neko" }));
  });

  it("falls back to FALLBACK_PET when the store has no pets", async () => {
    const user = userEvent.setup();
    useCCChanStore.setState({ pets: [], load: loadMock });
    render(<CCChanSettings value={createValue()} onChange={vi.fn()} />);

    const select = screen.getByRole("combobox");
    expect(select).toHaveTextContent(FALLBACK_PET.displayName);
    await user.click(select);
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("toggles autoStart / soundEnabled / windowVisible checkboxes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CCChanSettings value={createValue()} onChange={onChange} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(4);

    await user.click(checkboxes[0]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ autoStart: true }));

    await user.click(checkboxes[1]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ soundEnabled: false }));

    await user.click(checkboxes[2]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ windowVisible: false }));

    await user.click(checkboxes[3]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ wanderEnabled: true }));
  });

  it("changes the pet size via the slider and resets to the default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CCChanSettings value={createValue({ petSize: 200 })} onChange={onChange} />);

    const slider = screen.getByRole("slider");
    expect(slider).toHaveValue("200");

    await user.click(screen.getByRole("button", { name: "重置 120" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ petSize: 120 }));
  });

  it("opens the custom skin directory via the backend command", async () => {
    const user = userEvent.setup();
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined as never);

    render(<CCChanSettings value={createValue()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "打开皮肤目录" }));
    expect(mockInvoke).toHaveBeenCalledWith("open_ccchan_pets_dir");
  });

  it("shows the current window position and resets it to null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CCChanSettings value={createValue()} onChange={onChange} />);

    expect(screen.getByText(/x: 100 · y: 200/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重置位置" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ windowX: null, windowY: null }),
    );
  });

  it("renders a dash placeholder when the position is unset", () => {
    render(
      <CCChanSettings value={createValue({ windowX: null, windowY: null })} onChange={vi.fn()} />,
    );

    expect(screen.getByText(/x: - · y: -/)).toBeInTheDocument();
  });

  it("switches all cc-chan setting labels with the app language", async () => {
    await i18n.changeLanguage("en");
    render(<CCChanSettings value={createValue()} onChange={vi.fn()} />);

    expect(screen.getByText("AI Engine")).toBeInTheDocument();
    expect(screen.getByText("Default character")).toBeInTheDocument();
    expect(screen.getByText("Show on startup")).toBeInTheDocument();
    expect(screen.getByText("Notification sound")).toBeInTheDocument();
    expect(screen.getByText("Companion window visible")).toBeInTheDocument();
    expect(screen.getByText("Current position")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset position" })).toBeInTheDocument();
    expect(screen.queryByText("AI 引擎")).not.toBeInTheDocument();
  });

  it("localizes bundled pet descriptions while keeping custom descriptions intact", async () => {
    const yePet = {
      ...FALLBACK_PET,
      id: "ye-shunguang-jk",
      displayName: "叶瞬光JK (Ye Shunguang)",
      description: "绝区零角色叶瞬光（小师姐）的校园风小宠物，抱着笔记本和铅笔陪你工作、等待、复盘和冲刺。",
    };
    useCCChanStore.setState({ pets: [yePet], load: loadMock });

    await i18n.changeLanguage("en");
    render(
      <CCChanSettings
        value={createValue({ defaultPetId: "ye-shunguang-jk" })}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "A school-themed companion inspired by Ye Shunguang from Zenless Zone Zero, carrying a notebook and pencil to accompany you while you work, wait, review, and sprint.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(yePet.description)).not.toBeInTheDocument();

    await i18n.changeLanguage("zh-CN");
    expect(screen.getByText("来自《绝区零》叶瞬光（小师姐）的校园风小宠物，抱着笔记本和铅笔陪你工作、等待、复盘和冲刺。")).toBeInTheDocument();
  });
});
