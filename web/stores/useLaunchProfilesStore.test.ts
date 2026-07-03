import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLaunchProfilesStore } from "./useLaunchProfilesStore";
import { launchProfileService } from "@/services/launchProfileService";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfile, LaunchProfileResolution } from "@/types";

// Mock 底层 service（barrel `@/services` 再导出该模块，mock 生效）
vi.mock("@/services/launchProfileService", () => ({
  launchProfileService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn(),
    preview: vi.fn(),
  },
}));

const mockedService = vi.mocked(launchProfileService);

let idCounter = 0;
function createProfile(overrides?: Partial<LaunchProfile>): LaunchProfile {
  idCounter += 1;
  const now = new Date().toISOString();
  return {
    id: `profile-${idCounter}`,
    name: `profile-${idCounter}`,
    targetTools: [],
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("useLaunchProfilesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
  });

  describe("初始状态", () => {
    it("应有正确初始值", () => {
      const state = useLaunchProfilesStore.getState();
      expect(state.profiles).toEqual([]);
      expect(state.loading).toBe(false);
    });
  });

  describe("load", () => {
    it("应加载 profiles 列表", async () => {
      const profiles = [createProfile(), createProfile()];
      mockedService.list.mockResolvedValue(profiles);

      await useLaunchProfilesStore.getState().load();

      expect(mockedService.list).toHaveBeenCalledTimes(1);
      expect(useLaunchProfilesStore.getState().profiles).toEqual(profiles);
      expect(useLaunchProfilesStore.getState().loading).toBe(false);
    });

    it("加载期间应设置 loading 为 true", async () => {
      mockedService.list.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 10)),
      );

      const p = useLaunchProfilesStore.getState().load();
      expect(useLaunchProfilesStore.getState().loading).toBe(true);

      await p;
      expect(useLaunchProfilesStore.getState().loading).toBe(false);
    });

    it("加载失败时应抛出并复位 loading 为 false", async () => {
      mockedService.list.mockRejectedValue(new Error("加载失败"));

      await expect(
        useLaunchProfilesStore.getState().load(),
      ).rejects.toThrow("加载失败");

      expect(useLaunchProfilesStore.getState().loading).toBe(false);
    });
  });

  describe("create", () => {
    it("应创建 profile，随后 reload 并返回结果", async () => {
      const draft = defaultLaunchProfileDraft();
      const created = createProfile();
      mockedService.create.mockResolvedValue(created);
      mockedService.list.mockResolvedValue([created]);

      const result = await useLaunchProfilesStore.getState().create(draft);

      expect(mockedService.create).toHaveBeenCalledWith(draft);
      expect(mockedService.list).toHaveBeenCalledTimes(1);
      expect(result).toEqual(created);
      expect(useLaunchProfilesStore.getState().profiles).toEqual([created]);
    });

    it("创建失败时应抛出且不 reload", async () => {
      mockedService.create.mockRejectedValue(new Error("创建失败"));

      await expect(
        useLaunchProfilesStore.getState().create(defaultLaunchProfileDraft()),
      ).rejects.toThrow("创建失败");

      expect(mockedService.list).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("应更新 profile，随后 reload 并返回结果", async () => {
      const draft = defaultLaunchProfileDraft();
      const updated = createProfile({ name: "updated" });
      mockedService.update.mockResolvedValue(updated);
      mockedService.list.mockResolvedValue([updated]);

      const result = await useLaunchProfilesStore
        .getState()
        .update("profile-1", draft);

      expect(mockedService.update).toHaveBeenCalledWith("profile-1", draft);
      expect(result).toEqual(updated);
      expect(useLaunchProfilesStore.getState().profiles).toEqual([updated]);
    });
  });

  describe("remove", () => {
    it("应删除 profile，随后 reload", async () => {
      const remaining = createProfile();
      mockedService.remove.mockResolvedValue(undefined);
      mockedService.list.mockResolvedValue([remaining]);

      await useLaunchProfilesStore.getState().remove("profile-x");

      expect(mockedService.remove).toHaveBeenCalledWith("profile-x");
      expect(mockedService.list).toHaveBeenCalledTimes(1);
      expect(useLaunchProfilesStore.getState().profiles).toEqual([remaining]);
    });
  });

  describe("setDefault", () => {
    it("应设置默认 profile，随后 reload", async () => {
      const def = createProfile({ isDefault: true });
      mockedService.setDefault.mockResolvedValue(undefined);
      mockedService.list.mockResolvedValue([def]);

      await useLaunchProfilesStore.getState().setDefault("profile-1");

      expect(mockedService.setDefault).toHaveBeenCalledWith("profile-1");
      expect(useLaunchProfilesStore.getState().profiles).toEqual([def]);
    });
  });

  describe("preview", () => {
    it("应透传 preview 请求并返回解析结果（不改动 store 状态）", async () => {
      const resolution: LaunchProfileResolution = {
        mcpServers: [],
        skills: [],
        warnings: [],
        degraded: false,
      };
      mockedService.preview.mockResolvedValue(resolution);

      const request = { profileId: "profile-1" };
      const result = await useLaunchProfilesStore.getState().preview(request);

      expect(mockedService.preview).toHaveBeenCalledWith(request);
      expect(result).toEqual(resolution);
      expect(useLaunchProfilesStore.getState().profiles).toEqual([]);
    });
  });
});
