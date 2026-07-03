import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRunnerStore } from "./useRunnerStore";
import type {
  PortClaim,
  PortConflict,
  RunnerInstance,
  RunnerLaunchPlan,
  RunnerProfile,
  RunnerProfileDraft,
} from "@/types/runner";

const { serviceMock } = vi.hoisted(() => ({
  serviceMock: {
    listProfiles: vi.fn(),
    upsertProfile: vi.fn(),
    deleteProfile: vi.fn(),
    planLaunch: vi.fn(),
    listPortConflicts: vi.fn(),
    listActiveInstances: vi.fn(),
    refreshPortClaims: vi.fn(),
    killInstance: vi.fn(),
    killPid: vi.fn(),
  },
}));

vi.mock("@/services/runnerService", () => ({
  runnerService: serviceMock,
}));

function makeProfile(overrides?: Partial<RunnerProfile>): RunnerProfile {
  return {
    id: "p1",
    projectPath: "/proj/a",
    name: "dev",
    command: "npm run dev",
    cwd: "/proj/a",
    runtimeKind: "local",
    env: {},
    expectedPorts: [3000],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    ...overrides,
  };
}

function makeInstance(overrides?: Partial<RunnerInstance>): RunnerInstance {
  return {
    id: "i1",
    projectPath: "/proj/a",
    rootPid: 100,
    runtimeKind: "local",
    command: "npm run dev",
    cwd: "/proj/a",
    startedAt: "2024-01-01",
    status: "running",
    ...overrides,
  };
}

describe("useRunnerStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRunnerStore.setState({
      profilesByProject: {},
      activeInstances: [],
      portClaimsByInstance: {},
      loading: {},
    });
  });

  describe("初始状态", () => {
    it("应有空的初始集合", () => {
      const state = useRunnerStore.getState();
      expect(state.profilesByProject).toEqual({});
      expect(state.activeInstances).toEqual([]);
      expect(state.portClaimsByInstance).toEqual({});
      expect(state.loading).toEqual({});
    });
  });

  describe("loadProfiles", () => {
    it("应按项目路径加载并存储 profile 列表", async () => {
      const profiles = [makeProfile({ id: "p1" }), makeProfile({ id: "p2" })];
      serviceMock.listProfiles.mockResolvedValue(profiles);

      await useRunnerStore.getState().loadProfiles("/proj/a");

      expect(serviceMock.listProfiles).toHaveBeenCalledWith("/proj/a");
      expect(useRunnerStore.getState().profilesByProject["/proj/a"]).toEqual(
        profiles,
      );
    });

    it("加载期间应设置 loading，完成后清除", async () => {
      let resolveFn: (v: RunnerProfile[]) => void = () => {};
      serviceMock.listProfiles.mockReturnValue(
        new Promise<RunnerProfile[]>((resolve) => {
          resolveFn = resolve;
        }),
      );

      const promise = useRunnerStore.getState().loadProfiles("/proj/a");
      expect(useRunnerStore.getState().loading["profiles:/proj/a"]).toBe(true);

      resolveFn([]);
      await promise;
      expect(
        useRunnerStore.getState().loading["profiles:/proj/a"],
      ).toBeUndefined();
    });

    it("加载失败时应清除 loading 并抛出错误", async () => {
      serviceMock.listProfiles.mockRejectedValue(new Error("boom"));

      await expect(
        useRunnerStore.getState().loadProfiles("/proj/a"),
      ).rejects.toThrow("boom");
      expect(
        useRunnerStore.getState().loading["profiles:/proj/a"],
      ).toBeUndefined();
    });
  });

  describe("upsertProfile", () => {
    it("新建 profile 时应插入到桶的最前面", async () => {
      const existing = makeProfile({ id: "old" });
      useRunnerStore.setState({
        profilesByProject: { "/proj/a": [existing] },
      });
      const created = makeProfile({ id: "new" });
      serviceMock.upsertProfile.mockResolvedValue(created);

      const draft: RunnerProfileDraft = {
        projectPath: "/proj/a",
        name: "new",
        command: "x",
        cwd: "/proj/a",
        runtimeKind: "local",
      };
      const result = await useRunnerStore.getState().upsertProfile(draft);

      expect(result).toEqual(created);
      const bucket = useRunnerStore.getState().profilesByProject["/proj/a"];
      expect(bucket.map((p) => p.id)).toEqual(["new", "old"]);
    });

    it("更新已存在 profile 时应就地替换", async () => {
      const existing = makeProfile({ id: "p1", name: "old-name" });
      useRunnerStore.setState({
        profilesByProject: { "/proj/a": [existing] },
      });
      const updated = makeProfile({ id: "p1", name: "new-name" });
      serviceMock.upsertProfile.mockResolvedValue(updated);

      await useRunnerStore.getState().upsertProfile({
        id: "p1",
        projectPath: "/proj/a",
        name: "new-name",
        command: "x",
        cwd: "/proj/a",
        runtimeKind: "local",
      });

      const bucket = useRunnerStore.getState().profilesByProject["/proj/a"];
      expect(bucket).toHaveLength(1);
      expect(bucket[0].name).toBe("new-name");
    });

    it("目标项目还没有桶时应新建桶", async () => {
      const created = makeProfile({ id: "p1", projectPath: "/proj/new" });
      serviceMock.upsertProfile.mockResolvedValue(created);

      await useRunnerStore.getState().upsertProfile({
        projectPath: "/proj/new",
        name: "x",
        command: "x",
        cwd: "/proj/new",
        runtimeKind: "local",
      });

      expect(
        useRunnerStore.getState().profilesByProject["/proj/new"],
      ).toEqual([created]);
    });
  });

  describe("deleteProfile", () => {
    it("应从对应桶中移除 profile", async () => {
      useRunnerStore.setState({
        profilesByProject: {
          "/proj/a": [makeProfile({ id: "p1" }), makeProfile({ id: "p2" })],
        },
      });
      serviceMock.deleteProfile.mockResolvedValue(undefined);

      await useRunnerStore.getState().deleteProfile("p1", "/proj/a");

      expect(serviceMock.deleteProfile).toHaveBeenCalledWith("p1");
      const bucket = useRunnerStore.getState().profilesByProject["/proj/a"];
      expect(bucket.map((p) => p.id)).toEqual(["p2"]);
    });

    it("桶不存在时不应抛错", async () => {
      serviceMock.deleteProfile.mockResolvedValue(undefined);

      await expect(
        useRunnerStore.getState().deleteProfile("p1", "/missing"),
      ).resolves.toBeUndefined();
    });
  });

  describe("planLaunch / listPortConflicts", () => {
    it("planLaunch 应透传 service 返回值", async () => {
      const plan: RunnerLaunchPlan = {
        profileId: "p1",
        profileName: "dev",
        conflicts: [],
        suggestedActions: ["startDirect"],
      };
      serviceMock.planLaunch.mockResolvedValue(plan);

      const result = await useRunnerStore.getState().planLaunch("p1");
      expect(serviceMock.planLaunch).toHaveBeenCalledWith("p1");
      expect(result).toEqual(plan);
    });

    it("listPortConflicts 应透传 service 返回值", async () => {
      const conflicts: PortConflict[] = [
        { port: 3000, protocol: "tcp", pid: 42 },
      ];
      serviceMock.listPortConflicts.mockResolvedValue(conflicts);

      const result = await useRunnerStore
        .getState()
        .listPortConflicts([3000]);
      expect(serviceMock.listPortConflicts).toHaveBeenCalledWith([3000]);
      expect(result).toEqual(conflicts);
    });
  });

  describe("loadActiveInstances", () => {
    it("不带 projectPath 时应整体替换 activeInstances", async () => {
      useRunnerStore.setState({ activeInstances: [makeInstance({ id: "old" })] });
      const instances = [makeInstance({ id: "a" }), makeInstance({ id: "b" })];
      serviceMock.listActiveInstances.mockResolvedValue(instances);

      await useRunnerStore.getState().loadActiveInstances();

      expect(useRunnerStore.getState().activeInstances).toEqual(instances);
    });

    it("带 projectPath 时应只替换该项目实例并保留其他项目", async () => {
      useRunnerStore.setState({
        activeInstances: [
          makeInstance({ id: "other", projectPath: "/proj/b" }),
          makeInstance({ id: "stale", projectPath: "/proj/a" }),
        ],
      });
      const fresh = [makeInstance({ id: "fresh", projectPath: "/proj/a" })];
      serviceMock.listActiveInstances.mockResolvedValue(fresh);

      await useRunnerStore.getState().loadActiveInstances("/proj/a");

      const ids = useRunnerStore
        .getState()
        .activeInstances.map((i) => i.id)
        .sort();
      expect(ids).toEqual(["fresh", "other"]);
    });
  });

  describe("refreshPortClaims", () => {
    it("应缓存 instance 的 port claims", async () => {
      const claims: PortClaim[] = [
        {
          id: 1,
          pid: 42,
          port: 3000,
          protocol: "tcp",
          detectedAt: "2024-01-01",
        },
      ];
      serviceMock.refreshPortClaims.mockResolvedValue(claims);

      await useRunnerStore.getState().refreshPortClaims("i1");

      expect(useRunnerStore.getState().portClaimsByInstance["i1"]).toEqual(
        claims,
      );
    });
  });

  describe("killInstance", () => {
    it("成功杀死时应移除实例与 port claims", async () => {
      useRunnerStore.setState({
        activeInstances: [makeInstance({ id: "i1" }), makeInstance({ id: "i2" })],
        portClaimsByInstance: {
          i1: [
            { id: 1, pid: 42, port: 3000, protocol: "tcp", detectedAt: "x" },
          ],
        },
      });
      serviceMock.killInstance.mockResolvedValue(true);

      const killed = await useRunnerStore.getState().killInstance("i1");

      expect(killed).toBe(true);
      const state = useRunnerStore.getState();
      expect(state.activeInstances.map((i) => i.id)).toEqual(["i2"]);
      expect(state.portClaimsByInstance["i1"]).toBeUndefined();
    });

    it("未杀死时应保留实例", async () => {
      useRunnerStore.setState({
        activeInstances: [makeInstance({ id: "i1" })],
      });
      serviceMock.killInstance.mockResolvedValue(false);

      const killed = await useRunnerStore.getState().killInstance("i1");

      expect(killed).toBe(false);
      expect(useRunnerStore.getState().activeInstances).toHaveLength(1);
    });
  });

  describe("killPid", () => {
    it("应透传 service 返回值", async () => {
      serviceMock.killPid.mockResolvedValue(true);

      const result = await useRunnerStore.getState().killPid(1234);

      expect(serviceMock.killPid).toHaveBeenCalledWith(1234);
      expect(result).toBe(true);
    });
  });
});
