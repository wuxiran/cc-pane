import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useProvidersStore } from "@/stores";
import type { Provider, ProviderPreset } from "@/types/provider";
import ProviderFormPanel from "./ProviderFormPanel";

// lazy 加载的 CodeMirror 编辑器换成透传 textarea，便于断言双向同步
vi.mock("@/components/editor/JsonEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@/services/providerService", () => ({
  providerService: {
    readConfigDirInfo: vi.fn(),
    openPathInExplorer: vi.fn(),
  },
}));

vi.mock("@/services/filesystemService", () => ({
  filesystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({ tools: [] }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

function setupStore(providers: Provider[] = []) {
  const actions = {
    addProvider: vi.fn().mockResolvedValue(undefined),
    updateProvider: vi.fn().mockResolvedValue(undefined),
  };
  useProvidersStore.setState({ providers, ...actions });
  return actions;
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p-1",
    name: "Existing",
    providerType: "anthropic",
    apiKey: "sk-old",
    baseUrl: "https://api.anthropic.com",
    region: null,
    projectId: null,
    awsProfile: null,
    configDir: null,
    isDefault: true,
    ...overrides,
  };
}

const jsonEditor = () => screen.getByTestId("json-editor") as HTMLTextAreaElement;
const revealJson = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: i18n.t("settings:showSensitiveJson") }));
  return screen.findByTestId("json-editor");
};

describe("ProviderFormPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives the default provider type from the active CLI tab", () => {
    setupStore();
    render(<ProviderFormPanel activeTab="codex" onBack={vi.fn()} />);
    const typeSelect = screen.getByRole("combobox") as HTMLSelectElement;
    expect(typeSelect.value).toBe("open_ai");
  });

  it("mirrors form fields into the config JSON", async () => {
    const user = userEvent.setup();
    setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("sk-ant-..."), "sk-key");
    await user.type(screen.getByPlaceholderText("https://api.anthropic.com"), "https://x.dev");
    await revealJson(user);

    await waitFor(() => {
      const parsed = JSON.parse(jsonEditor().value);
      expect(parsed.env.ANTHROPIC_API_KEY).toBe("sk-key");
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://x.dev");
    });
  });

  it("parses config JSON edits back into the form fields", async () => {
    setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);
    await revealJson(userEvent.setup());

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(jsonEditor(), {
      target: {
        value: JSON.stringify({
          env: { ANTHROPIC_API_KEY: "from-json", ANTHROPIC_BASE_URL: "https://j.dev" },
        }),
      },
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk-ant-...")).toHaveValue("from-json");
      expect(screen.getByPlaceholderText("https://api.anthropic.com")).toHaveValue(
        "https://j.dev"
      );
    });
  });

  it("clears fields that the new provider type does not use", async () => {
    const user = userEvent.setup();
    setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("https://api.anthropic.com"), "https://x.dev");
    // anthropic → bedrock：baseUrl/apiKey 不再适用
    await user.selectOptions(screen.getByRole("combobox"), "bedrock");
    await revealJson(user);

    expect(screen.queryByPlaceholderText("https://api.anthropic.com")).not.toBeInTheDocument();
    const parsed = JSON.parse(jsonEditor().value);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(parsed.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("does not render API keys in the JSON editor until explicitly revealed", async () => {
    const user = userEvent.setup();
    const existing = makeProvider({ apiKey: "visible-only-after-confirmation" });
    setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
    await revealJson(user);
    expect(jsonEditor().value).toContain("visible-only-after-confirmation");
  });

  it("requires a name before saving", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    expect(toast.error).toHaveBeenCalledWith(i18n.t("settings:nameRequired"));
    expect(actions.addProvider).not.toHaveBeenCalled();
  });

  it("adds a new provider with empty fields normalized to null", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    const onBack = vi.fn();
    render(<ProviderFormPanel activeTab="claude" onBack={onBack} />);

    await user.type(
      screen.getByPlaceholderText(i18n.t("settings:providerNamePlaceholder")),
      "  New One  "
    );
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    await waitFor(() => {
      expect(actions.addProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New One",
          providerType: "anthropic",
          apiKey: null,
          baseUrl: null,
          region: null,
          isDefault: false,
        })
      );
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:providerAdded"));
    expect(onBack).toHaveBeenCalled();
  });

  it("updates an existing provider and preserves id and isDefault", async () => {
    const user = userEvent.setup();
    const existing = makeProvider();
    const actions = setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    // 编辑态字段预填
    expect(screen.getByDisplayValue("Existing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    await waitFor(() => {
      expect(actions.updateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p-1", isDefault: true, apiKey: "sk-old" })
      );
    });
    expect(actions.addProvider).not.toHaveBeenCalled();
  });

  it("hydrates a legacy provider with an empty model catalog", async () => {
    const user = userEvent.setup();
    const existing = makeProvider();
    const actions = setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    expect(screen.getByText(i18n.t("settings:noProviderModels"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    await waitFor(() => {
      expect(actions.updateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ models: [], defaultModelId: null })
      );
    });
  });

  it("prefills a new model row with the default 1M context window", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(i18n.t("settings:providerNamePlaceholder")),
      "Default Cap"
    );
    await user.click(
      screen.getByRole("button", { name: i18n.t("settings:addProviderModel") })
    );
    const row = screen.getByTestId("provider-model-row-0");
    await user.type(
      within(row).getByLabelText(i18n.t("settings:providerModelId")),
      "claude-sonnet-5"
    );

    // 「常用容量」下拉默认应是 1M（prefill，不再是「未知」），
    // 数字 input 同步显示 1000000，避免用户漏配导致 ContextUsage 显示「未知」。
    const presetSelect = within(row).getByTestId(
      "provider-model-context-window-preset-0"
    ) as HTMLSelectElement;
    expect(presetSelect.value).toBe("preset:1000000");
    const numberInput = within(row).getByLabelText(
      i18n.t("settings:providerModelContextWindow")
    ) as HTMLInputElement;
    expect(numberInput.value).toBe("1000000");

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    await waitFor(() => {
      expect(actions.addProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [expect.objectContaining({
            id: "claude-sonnet-5",
            contextWindowTokens: 1_000_000,
          })],
        })
      );
    });
  });

  it("adds the first model as the default and saves the catalog", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(i18n.t("settings:providerNamePlaceholder")),
      "Model Provider"
    );
    await user.click(
      screen.getByRole("button", { name: i18n.t("settings:addProviderModel") })
    );
    const row = screen.getByTestId("provider-model-row-0");
    await user.type(
      within(row).getByLabelText(i18n.t("settings:providerModelId")),
      "claude-sonnet-4-5"
    );
    await user.type(
      within(row).getByLabelText(i18n.t("settings:providerModelLabel")),
      "Sonnet 4.5"
    );
    await user.clear(
      within(row).getByLabelText(i18n.t("settings:providerModelContextWindow"))
    );
    await user.type(
      within(row).getByLabelText(i18n.t("settings:providerModelContextWindow")),
      "1000000"
    );
    await user.selectOptions(
      within(row).getByLabelText(i18n.t("settings:providerModelDefaultEffort")),
      "high"
    );

    expect(
      within(row).getByRole("button", {
        name: i18n.t("settings:defaultProviderModel"),
      })
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    await waitFor(() => {
      expect(actions.addProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [{
            id: "claude-sonnet-4-5",
            label: "Sonnet 4.5",
            defaultEffort: "high",
            contextWindowTokens: 1_000_000,
          }],
          defaultModelId: "claude-sonnet-4-5",
        })
      );
    });
  });

  it("hydrates model rows and supports changing and removing the default", async () => {
    const user = userEvent.setup();
    const existing = {
      ...makeProvider(),
      models: [
        { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
        { id: "claude-opus-4-1", label: "Opus 4.1" },
      ],
      defaultModelId: "claude-opus-4-1",
    } as Provider;
    const actions = setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    const rows = screen.getAllByTestId(/^provider-model-row-/);
    expect(
      within(rows[0]).getByLabelText(i18n.t("settings:providerModelId"))
    ).toHaveValue("claude-sonnet-4-5");
    expect(
      within(rows[1]).getByRole("button", {
        name: i18n.t("settings:defaultProviderModel"),
      })
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(
      within(rows[0]).getByRole("button", {
        name: i18n.t("settings:setDefaultProviderModel"),
      })
    );
    await user.click(
      within(rows[1]).getByRole("button", {
        name: i18n.t("settings:removeProviderModel"),
      })
    );
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    await waitFor(() => {
      expect(actions.updateProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [{
            id: "claude-sonnet-4-5",
            label: "Sonnet 4.5",
            defaultEffort: null,
          }],
          defaultModelId: "claude-sonnet-4-5",
        })
      );
    });
  });

  it("clears a model context window and saves it as unknown", async () => {
    const user = userEvent.setup();
    const existing = {
      ...makeProvider(),
      models: [{
        id: "claude-sonnet-4-5",
        label: "Sonnet 4.5",
        contextWindowTokens: 200_000,
      }],
      defaultModelId: "claude-sonnet-4-5",
    } as Provider;
    const actions = setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    const row = screen.getByTestId("provider-model-row-0");
    const contextWindowInput = within(row).getByLabelText(
      i18n.t("settings:providerModelContextWindow")
    );
    expect(contextWindowInput).toHaveValue(200_000);

    await user.clear(contextWindowInput);
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    await waitFor(() => {
      expect(actions.updateProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [expect.objectContaining({
            id: "claude-sonnet-4-5",
            contextWindowTokens: null,
          })],
          defaultModelId: "claude-sonnet-4-5",
        })
      );
    });
  });

  it("rejects a fractional model context window before saving", async () => {
    const user = userEvent.setup();
    const existing = {
      ...makeProvider(),
      models: [{ id: "claude-sonnet-4-5", contextWindowTokens: 200_000 }],
      defaultModelId: "claude-sonnet-4-5",
    } as Provider;
    const actions = setupStore([existing]);
    render(<ProviderFormPanel editProvider={existing} onBack={vi.fn()} />);

    const row = screen.getByTestId("provider-model-row-0");
    const contextWindowInput = within(row).getByLabelText(
      i18n.t("settings:providerModelContextWindow")
    );
    fireEvent.change(contextWindowInput, { target: { value: "10000000.5" } });
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    expect(toast.error).toHaveBeenCalledWith(
      i18n.t("settings:providerModelContextWindowInvalid")
    );
    expect(actions.updateProvider).not.toHaveBeenCalled();
  });

  it("shows save failures as an error toast and stays on the form", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    actions.addProvider.mockRejectedValue(new Error("io error"));
    const onBack = vi.fn();
    render(<ProviderFormPanel activeTab="claude" onBack={onBack} />);

    await user.type(
      screen.getByPlaceholderText(i18n.t("settings:providerNamePlaceholder")),
      "X"
    );
    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("shows only the preset's user fields with a fixed type in preset mode", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    const preset = {
      id: "preset-x",
      nameKey: "presetAnthropicName",
      providerType: "proxy",
      category: "official",
      order: 1,
      defaults: { baseUrl: "https://fixed.example.com" },
      userFields: ["apiKey"],
      accentColor: "#123456",
      website: "https://example.com",
    } as unknown as ProviderPreset;
    render(<ProviderFormPanel preset={preset} onBack={vi.fn()} />);

    // preset 模式下类型不可改（Badge 而非下拉）
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // baseUrl 由 preset 默认值提供且不在 userFields → 不展示，但保存时带上
    expect(
      screen.queryByPlaceholderText("https://api.anthropic.com")
    ).not.toBeInTheDocument();
    // apiKey 在 userFields → 可编辑
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument();
    // website 提供获取 API key 链接
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com");

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));
    await waitFor(() => {
      expect(actions.addProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          providerType: "proxy",
          baseUrl: "https://fixed.example.com",
        })
      );
    });
  });

  it("saves a duplicated provider as a new entry (add path, not update)", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    const onBack = vi.fn();
    const seed = makeProvider({
      name: "Anthropic A",
      apiKey: "sk-seed",
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }],
      defaultModelId: "claude-sonnet-5",
    });
    render(
      <ProviderFormPanel
        duplicateSeed={seed}
        activeTab="claude"
        onBack={onBack}
      />
    );

    // 表单预填：name 沿用 seed, apiKey 沿用 seed, 模型从 seed 拷贝
    expect(
      screen.getByDisplayValue("Anthropic A")
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("sk-seed")).toBeInTheDocument();
    expect(screen.getByTestId("provider-model-row-0")).toBeInTheDocument();

    // 标题应是「新增 Provider」，不能显示「编辑」字样
    expect(screen.queryByText(i18n.t("settings:editProvider"))).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings:addProvider"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: i18n.t("common:save") }));

    // 保存走 add 分支：seed 的 id 是已有 provider 的 id，不能误传给 update_provider。
    // 因此 addProvider 应被调用，而 updateProvider 必须没被调用。
    await waitFor(() => {
      expect(actions.addProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Anthropic A",
          apiKey: "sk-seed",
          models: [expect.objectContaining({ id: "claude-sonnet-5" })],
          defaultModelId: "claude-sonnet-5",
          isDefault: false,
        })
      );
    });
    expect(actions.updateProvider).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:providerAdded"));
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack from the cancel button without saving", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    const onBack = vi.fn();
    render(<ProviderFormPanel activeTab="claude" onBack={onBack} />);
    await user.click(screen.getByRole("button", { name: i18n.t("common:cancel") }));
    expect(onBack).toHaveBeenCalled();
    expect(actions.addProvider).not.toHaveBeenCalled();
  });
});
