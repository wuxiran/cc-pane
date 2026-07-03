import { render, screen, waitFor } from "@testing-library/react";
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

    await waitFor(() => {
      const parsed = JSON.parse(jsonEditor().value);
      expect(parsed.env.ANTHROPIC_API_KEY).toBe("sk-key");
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://x.dev");
    });
  });

  it("parses config JSON edits back into the form fields", async () => {
    setupStore();
    render(<ProviderFormPanel activeTab="claude" onBack={vi.fn()} />);

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

    expect(screen.queryByPlaceholderText("https://api.anthropic.com")).not.toBeInTheDocument();
    const parsed = JSON.parse(jsonEditor().value);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(parsed.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
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
