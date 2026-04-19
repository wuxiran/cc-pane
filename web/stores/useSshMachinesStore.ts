import { create } from "zustand";
import * as sshMachineService from "@/services/sshMachineService";
import type { SshMachine, SshMachineUpsertRequest } from "@/types";
import { handleErrorSilent } from "@/utils";

interface SshMachinesState {
  machines: SshMachine[];
  load: () => Promise<void>;
  add: (request: SshMachineUpsertRequest) => Promise<SshMachine>;
  update: (request: SshMachineUpsertRequest) => Promise<SshMachine>;
  remove: (id: string) => Promise<void>;
  findByConnection: (
    host: string,
    port: number,
    user?: string,
  ) => SshMachine | undefined;
}

export const useSshMachinesStore = create<SshMachinesState>((set, get) => ({
  machines: [],

  load: async () => {
    try {
      const machines = await sshMachineService.listSshMachines();
      set({ machines });
    } catch (e) {
      handleErrorSilent(e, "load ssh machines");
    }
  },

  add: async (request) => {
    const machine = await sshMachineService.addSshMachine(request);
    await get().load();
    return machine;
  },

  update: async (request) => {
    const machine = await sshMachineService.updateSshMachine(request);
    await get().load();
    return machine;
  },

  remove: async (id) => {
    await sshMachineService.removeSshMachine(id);
    await get().load();
  },

  findByConnection: (host, port, user) => {
    const h = host.toLowerCase().trim();
    const u = user?.toLowerCase().trim() || undefined;
    return get().machines.find(
      (m) =>
        m.host.toLowerCase().trim() === h &&
        m.port === port &&
        (m.user?.toLowerCase().trim() || undefined) === u,
    );
  },
}));
