import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { NativeConfigPreview } from "@/types";
import { useLaunchProfilesStore } from "@/stores";
import { nativeConfigService } from "@/services/nativeConfigService";
import LaunchProfileNativeConfigCard from "./LaunchProfileNativeConfigCard";

const preview: NativeConfigPreview = {
  cliTool: "claude",
  supported: true,
  entries: [
    { key: "alwaysThinkingEnabled", value: "true", source: "provider" },
    { key: "effortLevel", value: "\"high\"", source: "profile" },
    { key: "model", value: "\"opus\"", source: "managed" },
  ],
  runtimes: [
    { runtime: "local", applied: true },
    { runtime: "wsl", applied: false, note: "claudeSettingsLocalOnly" },
    { runtime: "ssh", applied: false, note: "claudeSettingsLocalOnly" },
  ],
  issues: [],
  providerName: "Relay",
  modelId: "opus",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(nativeConfigService, "validate").mockResolvedValue([]);
  useLaunchProfilesStore.setState({ previewNativeConfig: vi.fn().mockResolvedValue(preview) });
});

describe("LaunchProfileNativeConfigCard", () => {
  it("不支持原生配置的 CLI 不出这一段", () => {
    const { container } = render(<LaunchProfileNativeConfigCard draft={defaultLaunchProfileDraft()} setDraft={() => {}} activeTool="gemini" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("展开后列出每个键的来源层，并说明哪些运行位置不生效", async () => {
    render(<LaunchProfileNativeConfigCard draft={defaultLaunchProfileDraft()} setDraft={() => {}} activeTool="claude" />);
    fireEvent.click(screen.getByTestId("native-config-toggle"));
    await waitFor(() => expect(screen.getByText("alwaysThinkingEnabled")).toBeInTheDocument());
    const items = screen.getByTestId("native-config-preview").querySelectorAll("li");
    expect([...items].map((item) => item.getAttribute("data-source"))).toEqual(["provider", "profile", "managed"]);
    expect(screen.getByText(String(i18n.t("providers:nativeConfig.source.managed" as never)))).toBeInTheDocument();
    expect(screen.getByTestId("native-config-runtime-note")).toHaveTextContent("WSL / SSH");
  });

  it("编辑运行配置片段写回草稿", () => {
    const setDraft = vi.fn();
    render(<LaunchProfileNativeConfigCard
      draft={{ ...defaultLaunchProfileDraft(), nativeOverrides: { codex: "a = 1" } }}
      setDraft={setDraft}
      activeTool="codex"
    />);
    fireEvent.change(screen.getByTestId("native-config-profile-editor"), { target: { value: "service_tier = \"fast\"" } });
    const update = setDraft.mock.calls[0][0];
    expect(update({ ...defaultLaunchProfileDraft(), nativeOverrides: { codex: "a = 1" } }).nativeOverrides)
      .toEqual({ codex: "service_tier = \"fast\"" });
  });
});
