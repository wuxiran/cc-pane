import { create } from "zustand";
import type { DirListing } from "@/types/filesystem";

const MAX_DIRECTORY_CACHE_ENTRIES = 200;

interface SshRemoteFilesState {
  machineId: string | null;
  currentPath: string;
  history: string[];
  historyIndex: number;
  sessionPasswordMachineIds: string[];
  directoryCache: Record<string, DirListing>;
  openMachine: (machineId: string, initialPath?: string | null) => void;
  navigateTo: (path: string) => void;
  replaceCurrentPath: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  markSessionPassword: (machineId: string) => void;
  forgetSessionPassword: (machineId: string) => void;
  hasSessionPassword: (machineId: string) => boolean;
  getCachedDirectory: (
    machineId: string,
    path: string,
    showHidden: boolean,
  ) => DirListing | undefined;
  cacheDirectory: (
    machineId: string,
    requestedPath: string,
    showHidden: boolean,
    listing: DirListing,
  ) => void;
  clear: () => void;
}

function normalizeRemotePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || trimmed === "~") return trimmed;
  return trimmed.replace(/\/+$/, "") || "/";
}

function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === "~") return normalized;
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function directoryCacheKey(machineId: string, path: string, showHidden: boolean): string {
  return JSON.stringify([machineId, normalizeRemotePath(path), showHidden]);
}

export const useSshRemoteFilesStore = create<SshRemoteFilesState>((set, get) => ({
  machineId: null,
  currentPath: "/",
  history: [],
  historyIndex: -1,
  sessionPasswordMachineIds: [],
  directoryCache: {},

  openMachine: (machineId, initialPath) => {
    const path = normalizeRemotePath(initialPath || "/");
    set({ machineId, currentPath: path, history: [path], historyIndex: 0 });
  },

  navigateTo: (path) => {
    const normalized = normalizeRemotePath(path);
    const state = get();
    if (!normalized || normalized === state.currentPath) return;
    const history = state.history.slice(0, state.historyIndex + 1);
    history.push(normalized);
    set({ currentPath: normalized, history, historyIndex: history.length - 1 });
  },

  replaceCurrentPath: (path) => {
    const normalized = normalizeRemotePath(path);
    const state = get();
    if (!normalized || normalized === state.currentPath) return;
    const history = [...state.history];
    if (state.historyIndex >= 0) history[state.historyIndex] = normalized;
    else history.push(normalized);
    set({
      currentPath: normalized,
      history,
      historyIndex: state.historyIndex >= 0 ? state.historyIndex : 0,
    });
  },

  goBack: () => {
    const state = get();
    if (state.historyIndex <= 0) return;
    const historyIndex = state.historyIndex - 1;
    set({ historyIndex, currentPath: state.history[historyIndex] });
  },

  goForward: () => {
    const state = get();
    if (state.historyIndex >= state.history.length - 1) return;
    const historyIndex = state.historyIndex + 1;
    set({ historyIndex, currentPath: state.history[historyIndex] });
  },

  goUp: () => {
    const state = get();
    const parent = parentRemotePath(state.currentPath);
    if (parent !== state.currentPath) get().navigateTo(parent);
  },

  canGoBack: () => get().historyIndex > 0,
  canGoForward: () => get().historyIndex < get().history.length - 1,

  markSessionPassword: (machineId) => set((state) => ({
    sessionPasswordMachineIds: state.sessionPasswordMachineIds.includes(machineId)
      ? state.sessionPasswordMachineIds
      : [...state.sessionPasswordMachineIds, machineId],
  })),
  forgetSessionPassword: (machineId) => set((state) => ({
    sessionPasswordMachineIds: state.sessionPasswordMachineIds.filter((id) => id !== machineId),
  })),
  hasSessionPassword: (machineId) => get().sessionPasswordMachineIds.includes(machineId),

  getCachedDirectory: (machineId, path, showHidden) => (
    get().directoryCache[directoryCacheKey(machineId, path, showHidden)]
  ),
  cacheDirectory: (machineId, requestedPath, showHidden, listing) => set((state) => {
    const directoryCache = { ...state.directoryCache };
    directoryCache[directoryCacheKey(machineId, requestedPath, showHidden)] = listing;
    directoryCache[directoryCacheKey(machineId, listing.path, showHidden)] = listing;
    const keys = Object.keys(directoryCache);
    for (const key of keys.slice(0, keys.length - MAX_DIRECTORY_CACHE_ENTRIES)) {
      delete directoryCache[key];
    }
    return { directoryCache };
  }),

  clear: () => set({ machineId: null, currentPath: "/", history: [], historyIndex: -1 }),
}));
