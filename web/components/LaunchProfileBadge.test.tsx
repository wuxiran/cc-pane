import i18n from "@/i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { LaunchProfile } from "@/types/launch-profile";
import LaunchProfileBadge from "./LaunchProfileBadge";

vi.mock("@/services/launchProfileService", () => ({
  launchProfileService: { list: vi.fn().mockResolvedValue([]) },
}));

const workProfile = {
  id: "p-work",
  name: "工作",
  targetTools: ["claude"],
  providerId: "relay",
  modelId: "claude-opus-5-5",
  isDefault: false,
} as unknown as LaunchProfile;

describe("LaunchProfileBadge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    useLaunchProfilesStore.setState({ profiles: [workProfile], loading: false, loaded: true });
    useProvidersStore.setState({
      providers: [{ id: "relay", name: "Magpie", providerType: "anthropic", isDefault: false }],
    });
  });

  it("shows the profile name and a tooltip with credential and model", async () => {
    render(<LaunchProfileBadge mode="terminal" session={{ launchProfileId: "p-work", cliTool: "claude" }} />);
    const badge = screen.getByTestId("launch-profile-badge");
    expect(badge).toHaveTextContent("工作");
    expect(badge).toHaveAttribute("data-kind", "profile");

    await userEvent.hover(badge);
    const tooltip = await screen.findAllByTestId("launch-profile-badge-tooltip");
    expect(tooltip[0]).toHaveTextContent("中转站 · Magpie");
    expect(tooltip[0]).toHaveTextContent("claude-opus-5-5");
  });

  it("follows a rename and degrades to 已删除的配置 when the profile is gone", () => {
    const { rerender } = render(
      <LaunchProfileBadge mode="terminal" session={{ launchProfileId: "p-work", cliTool: "claude" }} />,
    );
    act(() => {
      useLaunchProfilesStore.setState({ profiles: [{ ...workProfile, alias: "新名字" }] });
    });
    expect(screen.getByTestId("launch-profile-badge")).toHaveTextContent("新名字");

    act(() => {
      useLaunchProfilesStore.setState({ profiles: [] });
    });
    rerender(<LaunchProfileBadge mode="terminal" session={{ launchProfileId: "p-work", cliTool: "claude" }} />);
    const badge = screen.getByTestId("launch-profile-badge");
    expect(badge).toHaveTextContent("已删除的配置");
    expect(badge).toHaveAttribute("data-kind", "deleted");
  });

  it("terminal without a profile shows 默认; plain shells show nothing", () => {
    const { unmount } = render(<LaunchProfileBadge mode="terminal" session={{ cliTool: "claude" }} />);
    expect(screen.getByTestId("launch-profile-badge")).toHaveTextContent("默认");
    unmount();
    render(<LaunchProfileBadge mode="terminal" session={{ cliTool: "none" }} />);
    expect(screen.queryByTestId("launch-profile-badge")).toBeNull();
  });

  it("chat only shows when the session recorded a profile", () => {
    const { unmount } = render(<LaunchProfileBadge mode="chat" session={{}} />);
    expect(screen.queryByTestId("launch-profile-badge")).toBeNull();
    unmount();
    render(<LaunchProfileBadge mode="chat" session={{ launchProfileId: "p-work" }} />);
    expect(screen.getByTestId("launch-profile-badge")).toHaveTextContent("工作");
  });

  it("does not claim deletion before profiles have loaded", () => {
    useLaunchProfilesStore.setState({ profiles: [], loaded: false, loading: true });
    render(<LaunchProfileBadge mode="terminal" session={{ launchProfileId: "p-work", cliTool: "claude" }} />);
    expect(screen.queryByTestId("launch-profile-badge")).toBeNull();
  });

  it("with a launch snapshot: renamed profile shows the new name, tooltip shows launched values", async () => {
    useLaunchProfilesStore.setState({ profiles: [{ ...workProfile, alias: "新名字" }] });
    const launchProfileSnapshot = {
      launchProfileId: "p-work",
      name: "工作",
      credential: { kind: "cli" as const },
      model: "sonnet-at-launch",
      capturedAt: "2026-11-25T00:00:00.000Z",
    };
    render(<LaunchProfileBadge mode="terminal" session={{ cliTool: "claude", launchProfileSnapshot }} />);
    const badge = screen.getByTestId("launch-profile-badge");
    expect(badge).toHaveTextContent("新名字");
    await userEvent.hover(badge);
    const tooltip = await screen.findAllByTestId("launch-profile-badge-tooltip");
    expect(tooltip[0]).toHaveTextContent("CLI 自带登录");
    expect(tooltip[0]).toHaveTextContent("sonnet-at-launch");
  });

  it("deleted profile keeps the launch-time name from the snapshot", () => {
    useLaunchProfilesStore.setState({ profiles: [] });
    const launchProfileSnapshot = { launchProfileId: "p-work", name: "工作", model: null, capturedAt: "" };
    render(<LaunchProfileBadge mode="chat" session={{ launchProfileId: "p-work", launchProfileSnapshot }} />);
    const badge = screen.getByTestId("launch-profile-badge");
    expect(badge).toHaveTextContent("工作（已删除）");
    expect(badge).toHaveAttribute("data-kind", "deleted");
  });

  it("a default switched after launch does not change a system-default snapshot", () => {
    useLaunchProfilesStore.setState({ profiles: [{ ...workProfile, isDefault: true, targetTools: [] }] });
    const launchProfileSnapshot = { launchProfileId: null, model: null, capturedAt: "" };
    render(<LaunchProfileBadge mode="terminal" session={{ cliTool: "claude", launchProfileSnapshot }} />);
    expect(screen.getByTestId("launch-profile-badge")).toHaveAttribute("data-kind", "systemDefault");
  });
});
