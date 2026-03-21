import { create } from "zustand";
import { processService } from "@/services";
import type { ProcessScanResult } from "@/types";
import { handleErrorSilent } from "@/utils";

interface ProcessMonitorState {
  scanResult: ProcessScanResult | null;
  scanning: boolean;
  killing: Set<number>;
  selectedPids: Set<number>;

  scan: () => Promise<void>;
  killProcess: (pid: number) => Promise<boolean>;
  killSelected: () => Promise<void>;
  killAll: () => Promise<void>;
  toggleSelect: (pid: number) => void;
  selectAll: () => void;
  clearSelection: () => void;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export const useProcessMonitorStore = create<ProcessMonitorState>((set, get) => ({
  scanResult: null,
  scanning: false,
  killing: new Set(),
  selectedPids: new Set(),

  scan: async () => {
    if (get().scanning) return;
    set({ scanning: true });
    try {
      const result = await processService.scan();
      // 清除不再存在的已选中 PID
      const existingPids = new Set(result.processes.map((p) => p.pid));
      const prevSelected = get().selectedPids;
      const newSelected = new Set([...prevSelected].filter((pid) => existingPids.has(pid)));
      set({ scanResult: result, selectedPids: newSelected });
    } catch (e) {
      handleErrorSilent(e, "scan processes");
    } finally {
      set({ scanning: false });
    }
  },

  killProcess: async (pid) => {
    set((s) => ({ killing: new Set([...s.killing, pid]) }));
    try {
      const success = await processService.killProcess(pid);
      if (success) {
        // 从选中列表移除
        set((s) => {
          const newSelected = new Set(s.selectedPids);
          newSelected.delete(pid);
          return { selectedPids: newSelected };
        });
        // 刷新列表
        await get().scan();
      }
      return success;
    } catch (e) {
      handleErrorSilent(e, "kill process");
      return false;
    } finally {
      set((s) => {
        const newKilling = new Set(s.killing);
        newKilling.delete(pid);
        return { killing: newKilling };
      });
    }
  },

  killSelected: async () => {
    const pids = [...get().selectedPids];
    if (pids.length === 0) return;
    try {
      await processService.killProcesses(pids);
      set({ selectedPids: new Set() });
      await get().scan();
    } catch (e) {
      handleErrorSilent(e, "kill selected processes");
    }
  },

  killAll: async () => {
    const processes = get().scanResult?.processes;
    if (!processes || processes.length === 0) return;
    const pids = processes.map((p) => p.pid);
    try {
      await processService.killProcesses(pids);
      set({ selectedPids: new Set() });
      await get().scan();
    } catch (e) {
      handleErrorSilent(e, "kill all processes");
    }
  },

  toggleSelect: (pid) => {
    set((s) => {
      const newSelected = new Set(s.selectedPids);
      if (newSelected.has(pid)) {
        newSelected.delete(pid);
      } else {
        newSelected.add(pid);
      }
      return { selectedPids: newSelected };
    });
  },

  selectAll: () => {
    const processes = get().scanResult?.processes;
    if (!processes) return;
    set({ selectedPids: new Set(processes.map((p) => p.pid)) });
  },

  clearSelection: () => {
    set({ selectedPids: new Set() });
  },

  startAutoRefresh: () => {
    if (refreshTimer) return;
    // 立即执行一次扫描
    get().scan();
    // 每 30 秒自动刷新
    refreshTimer = setInterval(() => {
      get().scan();
    }, 30_000);
  },

  stopAutoRefresh: () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  },
}));
