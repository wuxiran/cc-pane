import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSshMachinesStore } from "./useSshMachinesStore";
import * as sshMachineService from "@/services/sshMachineService";
import type { SshMachine, SshMachineUpsertRequest } from "@/types";

// Mock 底层前端 service（store 依赖 service，而非直接 invoke）
vi.mock("@/services/sshMachineService", () => ({
  listSshMachines: vi.fn(),
  addSshMachine: vi.fn(),
  updateSshMachine: vi.fn(),
  removeSshMachine: vi.fn(),
}));

const mockedService = vi.mocked(sshMachineService);

let idCounter = 0;
function createMachine(overrides?: Partial<SshMachine>): SshMachine {
  idCounter += 1;
  const now = new Date().toISOString();
  return {
    id: `machine-${idCounter}`,
    name: `machine-${idCounter}`,
    host: `192.168.0.${idCounter}`,
    port: 22,
    user: "root",
    authMethod: "agent",
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function upsertRequest(machine: SshMachine): SshMachineUpsertRequest {
  return {
    machine,
    rememberPassword: false,
    clearStoredPassword: false,
  };
}

describe("useSshMachinesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    useSshMachinesStore.setState({ machines: [] });
  });

  describe("初始状态", () => {
    it("machines 应为空数组", () => {
      expect(useSshMachinesStore.getState().machines).toEqual([]);
    });
  });

  describe("load", () => {
    it("应加载机器列表并写入 machines", async () => {
      const machines = [createMachine(), createMachine()];
      mockedService.listSshMachines.mockResolvedValue(machines);

      await useSshMachinesStore.getState().load();

      expect(mockedService.listSshMachines).toHaveBeenCalledTimes(1);
      expect(useSshMachinesStore.getState().machines).toEqual(machines);
    });

    it("加载失败时应静默处理且保持原有 machines 不变", async () => {
      const existing = [createMachine()];
      useSshMachinesStore.setState({ machines: existing });
      mockedService.listSshMachines.mockRejectedValue(new Error("加载失败"));

      await expect(
        useSshMachinesStore.getState().load(),
      ).resolves.toBeUndefined();

      expect(useSshMachinesStore.getState().machines).toEqual(existing);
    });
  });

  describe("add", () => {
    it("应调用 addSshMachine，随后 reload 并返回新机器", async () => {
      const machine = createMachine();
      mockedService.addSshMachine.mockResolvedValue(machine);
      mockedService.listSshMachines.mockResolvedValue([machine]);

      const result = await useSshMachinesStore
        .getState()
        .add(upsertRequest(machine));

      expect(mockedService.addSshMachine).toHaveBeenCalledWith(
        upsertRequest(machine),
      );
      expect(mockedService.listSshMachines).toHaveBeenCalledTimes(1);
      expect(result).toEqual(machine);
      expect(useSshMachinesStore.getState().machines).toEqual([machine]);
    });

    it("addSshMachine 失败时应向上抛出且不 reload", async () => {
      const machine = createMachine();
      mockedService.addSshMachine.mockRejectedValue(new Error("添加失败"));

      await expect(
        useSshMachinesStore.getState().add(upsertRequest(machine)),
      ).rejects.toThrow("添加失败");

      expect(mockedService.listSshMachines).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("应调用 updateSshMachine，随后 reload 并返回更新后的机器", async () => {
      const machine = createMachine();
      const updated = { ...machine, name: "renamed" };
      mockedService.updateSshMachine.mockResolvedValue(updated);
      mockedService.listSshMachines.mockResolvedValue([updated]);

      const result = await useSshMachinesStore
        .getState()
        .update(upsertRequest(updated));

      expect(mockedService.updateSshMachine).toHaveBeenCalledWith(
        upsertRequest(updated),
      );
      expect(result).toEqual(updated);
      expect(useSshMachinesStore.getState().machines).toEqual([updated]);
    });
  });

  describe("remove", () => {
    it("应调用 removeSshMachine，随后 reload", async () => {
      const remaining = createMachine();
      mockedService.removeSshMachine.mockResolvedValue(undefined);
      mockedService.listSshMachines.mockResolvedValue([remaining]);

      await useSshMachinesStore.getState().remove("machine-to-delete");

      expect(mockedService.removeSshMachine).toHaveBeenCalledWith(
        "machine-to-delete",
      );
      expect(mockedService.listSshMachines).toHaveBeenCalledTimes(1);
      expect(useSshMachinesStore.getState().machines).toEqual([remaining]);
    });
  });

  describe("findByConnection", () => {
    beforeEach(() => {
      useSshMachinesStore.setState({
        machines: [
          createMachine({
            id: "m1",
            host: "Example.COM",
            port: 22,
            user: "Root",
          }),
          createMachine({ id: "m2", host: "10.0.0.1", port: 2222, user: undefined }),
        ],
      });
    });

    it("应忽略大小写与首尾空格匹配 host / user", () => {
      const found = useSshMachinesStore
        .getState()
        .findByConnection("  example.com  ", 22, " root ");

      expect(found?.id).toBe("m1");
    });

    it("端口不同应返回 undefined", () => {
      const found = useSshMachinesStore
        .getState()
        .findByConnection("example.com", 2200, "root");

      expect(found).toBeUndefined();
    });

    it("应匹配 user 为空的机器（不传 user）", () => {
      const found = useSshMachinesStore
        .getState()
        .findByConnection("10.0.0.1", 2222);

      expect(found?.id).toBe("m2");
    });

    it("传了 user 但机器 user 为空应不匹配", () => {
      const found = useSshMachinesStore
        .getState()
        .findByConnection("10.0.0.1", 2222, "someone");

      expect(found).toBeUndefined();
    });

    it("无匹配时应返回 undefined", () => {
      const found = useSshMachinesStore
        .getState()
        .findByConnection("nope.example.com", 22, "root");

      expect(found).toBeUndefined();
    });
  });
});
