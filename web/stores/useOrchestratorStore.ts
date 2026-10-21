import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createOrchestratorCache } from "./orchestratorCache";
import { createLoadingActions } from "./orchestratorLoading";
import { createMutationActions } from "./orchestratorMutations";
import { activeQuery, buildTaskTree, ensureSelectedTask, matchesQuery, readSelectedTaskId, syncSelectedTaskId } from "./orchestratorProjection";
import type { OrchestratorState } from "./orchestratorState";

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    immer((set, get) => {
      const cache = createOrchestratorCache();
      const changeFilter = (change: (state: OrchestratorState) => void) => {
        set((state) => {
          change(state); state.filterGeneration++; state.queryOverrides = {}; state.baseOffset = 0;
          state.loadedWindowSize = state.pageLimit; state.failedWindowSize = null; state.loadError = null;
          state.bindings = state.bindings.filter((item) => matchesQuery(item, activeQuery(state)));
          state.total = state.bindings.length; state.hasMore = false; state.loading = false;
          ensureSelectedTask(state);
        });
        void get().loadBindings();
      };
      return {
        bindings: [], total: 0, hasMore: false, pageLimit: 50, loadedWindowSize: 50, loading: false,
        loadError: null, failedWindowSize: null, baseOffset: 0, queryOverrides: {}, filterGeneration: 0,
        requestGeneration: 0, mutationVersion: 0, queryCommitVersion: 0, knownBindings: {}, mutationVersions: {},
        filterTab: "all", filterWorkspace: null, filterProjectPath: null, filterRole: null, searchKeyword: "",
        lastTargetProjectPath: null, viewType: "list", selectedTaskId: readSelectedTaskId(),
        ...createLoadingActions(set, get, cache), ...createMutationActions(set, get, cache),
        setFilterTab: (tab) => changeFilter((state) => { state.filterTab = tab; }),
        setFilterWorkspace: (workspace) => changeFilter((state) => { state.filterWorkspace = workspace; state.filterProjectPath = null; }),
        setFilterProjectPath: (path) => changeFilter((state) => { state.filterProjectPath = path; }),
        setFilterRole: (role) => changeFilter((state) => { state.filterRole = role; }),
        setSearchKeyword: (keyword) => changeFilter((state) => { state.searchKeyword = keyword; }),
        setLastTargetProjectPath: (path) => set((state) => { state.lastTargetProjectPath = path; }),
        setViewType: (type) => set((state) => { state.viewType = type; }),
        setSelectedTaskId: (id) => set((state) => { state.selectedTaskId = id; syncSelectedTaskId(id); }),
        getTaskTree: () => buildTaskTree(get().bindings),
        getVisibleBindings: () => get().bindings,
        getActivityBadge: () => ({
          failed: get().bindings.some((binding) => binding.status === "failed"),
          activeCount: get().bindings.filter((binding) => binding.status === "running" || binding.status === "waiting").length,
        }),
      };
    }),
    { name: "cc-panes-orchestrator", partialize: (state) => ({ lastTargetProjectPath: state.lastTargetProjectPath }) },
  ),
);
