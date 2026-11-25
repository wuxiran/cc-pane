import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfileDraft, NativeConfigPreview } from "@/types";
import { useLaunchProfilesStore } from "@/stores";
import NativeConfigQuickToggles, { literalToText, NATIVE_QUICK_KEYS } from "./NativeConfigQuickToggles";

const tr = (key: string, options?: Record<string, unknown>) => String(i18n.t(`providers:${key}` as never, options as never));

function previewOf(entries: NativeConfigPreview["entries"]): NativeConfigPreview {
  return { cliTool: "codex", supported: true, entries, runtimes: [], issues: [] };
}

/** 有本层片段 → 本层值；去掉本层片段 → 只剩中转站的 fast。 */
const previewNativeConfig = vi.fn(async (draft: LaunchProfileDraft) => (draft.nativeOverrides?.codex
  ? previewOf([{ key: "service_tier", value: "\"flex\"", source: "profile" }])
  : previewOf([{ key: "service_tier", value: "\"fast\"", source: "provider" }])));

const setNativeConfigKey = vi.fn();

beforeEach(() => {
  previewNativeConfig.mockClear();
  setNativeConfigKey.mockReset();
  useLaunchProfilesStore.setState({ previewNativeConfig, setNativeConfigKey });
});

describe("literalToText", () => {
  it("字符串字面量去引号，其余原样", () => {
    expect(literalToText("\"fast\"")).toBe("fast");
    expect(literalToText("200000")).toBe("200000");
    expect(literalToText("true")).toBe("true");
    expect(literalToText("'raw'")).toBe("'raw'");
  });
});

describe("NativeConfigQuickToggles", () => {
  it("Claude 不出快捷开关", () => {
    const { container } = render(
      <NativeConfigQuickToggles draft={defaultLaunchProfileDraft()} setDraft={() => {}} tool="claude" preview={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("本层未设置时选中「继承」，并显示去掉本层后的继承值", async () => {
    render(<NativeConfigQuickToggles draft={defaultLaunchProfileDraft()} setDraft={() => {}} tool="codex" preview={null} />);
    const row = screen.getByTestId("native-config-quick-service_tier");
    expect(row.querySelector("[aria-selected='true']")).toHaveTextContent(tr("nativeConfig.quick.inherit"));
    await waitFor(() => expect(screen.getByTestId("native-config-quick-service_tier-inherited")).toHaveTextContent(
      tr("nativeConfig.quick.inheritedFrom", { source: tr("nativeConfig.source.provider"), value: "fast" }),
    ));
    // 去掉本层后的预览：没有 codex 片段
    expect(previewNativeConfig.mock.calls[0][0].nativeOverrides?.codex).toBeUndefined();
    expect(screen.getByTestId("native-config-quick-model_verbosity-inherited"))
      .toHaveTextContent(tr("nativeConfig.quick.inheritedNone"));
  });

  it("点选项经后端改片段并写回草稿；本层已设置时高亮该值，点「继承」删除该键", async () => {
    const draft = { ...defaultLaunchProfileDraft(), nativeOverrides: { codex: "# mine\nservice_tier = \"flex\"\n" } };
    const setDraft = vi.fn();
    setNativeConfigKey.mockResolvedValue("# mine\n");
    const ownPreview = previewOf([{ key: "service_tier", value: "\"flex\"", source: "profile" }]);
    render(<NativeConfigQuickToggles draft={draft} setDraft={setDraft} tool="codex" preview={ownPreview} />);
    const row = screen.getByTestId("native-config-quick-service_tier");
    expect(row.querySelector("[aria-selected='true']")).toHaveTextContent("flex");

    fireEvent.click(screen.getAllByRole("tab", { name: tr("nativeConfig.quick.inherit") })[0]);
    expect(setNativeConfigKey).toHaveBeenCalledWith("codex", draft.nativeOverrides.codex, "service_tier", null);
    await waitFor(() => expect(setDraft).toHaveBeenCalled());
    const update = setDraft.mock.calls[0][0];
    expect(update(draft).nativeOverrides).toEqual({ codex: "# mine\n" });
    // 请求期间片段被手改过：不覆盖
    const edited = { ...draft, nativeOverrides: { codex: "service_tier = \"auto\"" } };
    expect(update(edited)).toBe(edited);
  });

  it("片段有语法错误时报错，不改草稿", async () => {
    const setDraft = vi.fn();
    setNativeConfigKey.mockRejectedValue("fix the TOML syntax error before using quick toggles");
    render(<NativeConfigQuickToggles draft={defaultLaunchProfileDraft()} setDraft={setDraft} tool="codex" preview={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "fast" }));
    await waitFor(() => expect(screen.getByTestId("native-config-quick-error")).toHaveTextContent("TOML syntax error"));
    expect(setDraft).not.toHaveBeenCalled();
  });
  it("Codex 快捷键含计划模式推理强度与自动压缩阈值，不含托管的 model_reasoning_effort", () => {
    const keys = NATIVE_QUICK_KEYS.codex.map((quick) => quick.key);
    expect(keys).toEqual(expect.arrayContaining(["plan_mode_reasoning_effort", "model_auto_compact_token_limit"]));
    expect(keys).not.toContain("model_reasoning_effort");
  });

  it("plan_mode_reasoning_effort 下拉：列出 Codex 推理强度，选中后写入该键，并显示继承值", async () => {
    const user = userEvent.setup();
    setNativeConfigKey.mockResolvedValue("plan_mode_reasoning_effort = \"high\"\n");
    render(<NativeConfigQuickToggles draft={defaultLaunchProfileDraft()} setDraft={vi.fn()} tool="codex" preview={null} />);
    await waitFor(() => expect(screen.getByTestId("native-config-quick-plan_mode_reasoning_effort-inherited"))
      .toHaveTextContent(tr("nativeConfig.quick.inheritedNone")));
    const trigger = screen.getByRole("combobox", { name: "plan_mode_reasoning_effort" });
    expect(trigger).toHaveTextContent(tr("nativeConfig.quick.inherit"));
    await user.click(trigger);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([tr("nativeConfig.quick.inherit"), "none", "minimal", "low", "medium", "high", "xhigh"]);
    await user.click(screen.getByRole("option", { name: "high" }));
    expect(setNativeConfigKey).toHaveBeenCalledWith("codex", "", "plan_mode_reasoning_effort", "high");
  });

  it("model_auto_compact_token_limit 数字框：提交数字、留空删除该键、非正整数不提交", () => {
    setNativeConfigKey.mockResolvedValue("");
    const draft = { ...defaultLaunchProfileDraft(), nativeOverrides: { codex: "model_auto_compact_token_limit = 200000\n" } };
    const ownPreview = previewOf([{ key: "model_auto_compact_token_limit", value: "200000", source: "profile" }]);
    render(<NativeConfigQuickToggles draft={draft} setDraft={vi.fn()} tool="codex" preview={ownPreview} />);
    const input = screen.getByRole("spinbutton", { name: "model_auto_compact_token_limit" });
    expect(input).toHaveValue(200000);
    expect(input).toHaveAttribute("placeholder", tr("nativeConfig.quick.numberPlaceholder"));

    fireEvent.change(input, { target: { value: "150000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setNativeConfigKey).toHaveBeenLastCalledWith("codex", draft.nativeOverrides.codex, "model_auto_compact_token_limit", 150000);

    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.blur(input);
    expect(setNativeConfigKey).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("native-config-quick-model_auto_compact_token_limit-invalid")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(setNativeConfigKey).toHaveBeenLastCalledWith("codex", draft.nativeOverrides.codex, "model_auto_compact_token_limit", null);
  });
});
