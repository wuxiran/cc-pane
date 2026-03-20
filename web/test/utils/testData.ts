import type {
  Project,
  Provider,
  Workspace,
  WorkspaceProject,
  AppSettings,
  Memory,
  SkillInfo,
} from "@/types";

let counter = 0;

function nextId(): string {
  counter += 1;
  return `test-${counter}`;
}

/**
 * 创建测试用 Project 数据
 */
export function createTestProject(overrides?: Partial<Project>): Project {
  const id = nextId();
  return {
    id,
    name: `project-${id}`,
    path: `/tmp/test/${id}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 创建多个测试 Project
 */
export function createTestProjects(count: number): Project[] {
  return Array.from({ length: count }, () => createTestProject());
}

/**
 * 创建测试用 Provider 数据
 */
export function createTestProvider(overrides?: Partial<Provider>): Provider {
  const id = nextId();
  return {
    id,
    name: `provider-${id}`,
    providerType: "anthropic",
    apiKey: "test-key",
    baseUrl: null,
    region: null,
    projectId: null,
    awsProfile: null,
    configDir: null,
    isDefault: false,
    ...overrides,
  };
}

/**
 * 创建测试用 Workspace 数据
 */
export function createTestWorkspace(overrides?: Partial<Workspace>): Workspace {
  const id = nextId();
  return {
    id,
    name: `workspace-${id}`,
    createdAt: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

/**
 * 创建测试用 WorkspaceProject 数据
 */
export function createTestWorkspaceProject(overrides?: Partial<WorkspaceProject>): WorkspaceProject {
  const id = nextId();
  return {
    id,
    path: `/tmp/test/${id}`,
    ...overrides,
  };
}

/**
 * 创建测试用 AppSettings 数据
 */
export function createTestSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    proxy: {
      enabled: false,
      proxyType: "http",
      host: "",
      port: 0,
      username: null,
      password: null,
      noProxy: null,
    },
    theme: { mode: "dark" },
    terminal: {
      fontSize: 14,
      fontFamily: "monospace",
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 1000,
      shell: null,
      disableConptySanitize: null,
    },
    shortcuts: { bindings: {} },
    general: {
      closeToTray: false,
      autoStart: false,
      language: "en",
      dataDir: null,
      searchScope: "Workspace",
      onboardingCompleted: false,
      defaultCliTool: "claude",
    },
    notification: {
      enabled: true,
      onExit: true,
      onWaitingInput: true,
      onlyWhenUnfocused: true,
    },
    screenshot: {
      shortcut: "Ctrl+Shift+S",
      retentionDays: 7,
    },
    ...overrides,
  };
}

/**
 * 创建测试用 Memory 数据
 */
export function createTestMemory(overrides?: Partial<Memory>): Memory {
  const id = nextId();
  const now = new Date().toISOString();
  return {
    id,
    title: `memory-${id}`,
    content: `Test memory content ${id}`,
    scope: "global",
    category: "fact",
    importance: 3,
    workspace_name: null,
    project_path: null,
    session_id: null,
    tags: [],
    source: "user",
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
    user_id: null,
    sync_status: "local_only",
    sync_version: 0,
    is_deleted: false,
    ...overrides,
  };
}

/**
 * 创建测试用 SkillInfo 数据
 */
export function createTestSkill(overrides?: Partial<SkillInfo>): SkillInfo {
  const id = nextId();
  return {
    name: `skill-${id}`,
    content: `# Skill ${id}\nTest skill content`,
    filePath: `/tmp/skills/${id}.md`,
    ...overrides,
  };
}

/**
 * 重置计数器（在 beforeEach 中调用）
 */
export function resetTestDataCounter(): void {
  counter = 0;
}
