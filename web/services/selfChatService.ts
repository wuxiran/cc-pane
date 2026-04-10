/**
 * Self-Chat 服务
 *
 * 提供应用级上下文收集（工作空间、Todo、可用 Skill），
 * 以及 getAppCwd() 获取 CC-Panes 项目根目录。
 */
import { invoke } from "@tauri-apps/api/core";
import { useWorkspacesStore } from "@/stores";
import { todoService } from "./todoService";

/** 获取应用当前工作目录 */
async function getAppCwd(): Promise<string> {
  return invoke<string>("get_app_cwd");
}

/** 收集应用级上下文并组装 prompt */
async function collectAppContext(): Promise<string> {
  const sections: string[] = [];

  // 1. 工作空间概览
  const workspaces = useWorkspacesStore.getState().workspaces;
  if (workspaces.length > 0) {
    const wsLines = workspaces.map(
      (ws) => `- ${ws.alias || ws.name}（${ws.projects.length} 个项目）`
    );
    sections.push(`## 工作空间 (${workspaces.length} 个)\n${wsLines.join("\n")}`);
  }

  // 2. Todo 统计（全局待办）
  try {
    const result = await todoService.query({
      status: "todo",
      limit: 10,
      offset: 0,
    });
    if (result.items.length > 0) {
      const todoLines = result.items.map(
        (t) => `- [${t.priority}] ${t.title}${t.description ? ` — ${t.description.slice(0, 80)}` : ""}`
      );
      sections.push(
        `## 待办事项 (${result.total} 项)\n${todoLines.join("\n")}` +
          (result.total > 10 ? `\n- ... 还有 ${result.total - 10} 项` : "")
      );
    }
  } catch {
    // 无 todo，跳过
  }

  // 3. 可用 Skill 列表
  sections.push(
    `## 可用 Skill\n` +
    `- /ccbook:workspace — 工作空间管理（CRUD、项目管理）\n` +
    `- /ccbook:start — 启动会话\n` +
    `- /ccbook:launch-task — 在指定项目中启动 Claude/Codex 执行任务\n` +
    `- /ccbook:check-backend — 后端代码检查\n` +
    `- /ccbook:check-frontend — 前端代码检查\n` +
    `- /ccbook:check-cross-layer — 跨层检查\n` +
    `- /ccbook:check-tauri-bridge — Tauri 桥接一致性检查\n` +
    `- /ccbook:finish-work — 完成工作检查清单\n` +
    `- /ccbook:onboard — 项目导师介绍\n` +
    `- /ccbook:parallel — 多 Agent 并行编排`
  );

  // 4. 系统提示
  const systemHint =
    `你是 CC-Panes 的操控助手。CC-Panes 是一个多 CLI 的多实例分屏管理桌面应用。\n` +
    `你可以使用上面列出的 /ccbook:* skill 来帮助用户管理工作空间、Todo、Plans 等。\n\n` +
    `你拥有 ccpanes MCP 工具（12 个），按类别分组：\n` +
    `- 编排: launch_task（启动 Claude/Codex 实例）、list_projects（已注册项目）、get_task_status（任务状态）\n` +
    `- 工作空间: list_workspaces、get_workspace、create_workspace、add_project_to_workspace、scan_directory\n` +
    `- 待办: query_todos、create_todo、update_todo\n` +
    `- Skill: list_skills（查看项目可用命令模板）\n\n` +
    `典型场景：\n` +
    `- 用户给目录路径 → scan_directory 发现项目 → create_workspace → add_project_to_workspace → launch_task\n` +
    `- 用 create_todo 跟踪多 Agent 工作进度，用 update_todo 更新状态\n` +
    `- 用 list_skills 查看项目可用 Skill，指导子 Agent 使用合适的命令\n\n` +
    `当用户需要在多个项目中并行执行任务时，使用 /ccbook:launch-task 启动新的 Claude 或 Codex 实例。\n` +
    `请用中文回复。`;

  const contextBlock = sections.length > 0
    ? `${sections.join("\n\n")}\n\n${systemHint}`
    : systemHint;

  return contextBlock;
}

/**
 * 收集 Onboarding 模式的系统提示
 *
 * @param language 当前界面语言（"zh-CN" | "en"）
 */
function collectOnboardingContext(language: string): string {
  const isZh = language.startsWith("zh");

  if (isZh) {
    return (
      `你是 CC-Panes 的新手引导助手。你正在帮助一位首次使用 CC-Panes 的新用户。\n` +
      `请用中文与用户交流，语气友好专业。\n\n` +
      `## 你的任务\n` +
      `1. 先简要介绍 CC-Panes 的核心概念：\n` +
      `   - 工作空间 (Workspace)：多项目集合，包含配置和会话日志\n` +
      `   - 项目 (Project)：对应一个 Git 仓库或代码目录\n` +
      `   - 任务 (Task)：项目下的具体任务，对应一个终端标签页\n\n` +
      `2. 引导用户创建第一个工作空间：\n` +
      `   - 询问用户常用的项目目录路径\n` +
      `   - 使用 ccpanes MCP 工具 scan_directory 扫描该目录发现项目\n` +
      `   - 使用 create_workspace 创建工作空间\n` +
      `   - 使用 add_project_to_workspace 将发现的项目添加到工作空间\n\n` +
      `3. 完成后告诉用户：\n` +
      `   - 可以点击左侧活动栏的树形图标切换到 Explorer 视图\n` +
      `   - 在 Explorer 中右键项目可以启动 Claude Code\n` +
      `   - 可以通过分屏功能同时管理多个 Claude Code 实例\n\n` +
      `## 可用的 ccpanes MCP 工具\n` +
      `- scan_directory: 扫描指定目录发现 Git 仓库和项目\n` +
      `- create_workspace: 创建新的工作空间\n` +
      `- add_project_to_workspace: 将项目添加到工作空间\n` +
      `- list_workspaces: 列出所有工作空间\n` +
      `- list_projects: 列出所有已注册的项目\n\n` +
      `## 注意\n` +
      `- 保持对话简洁友好\n` +
      `- 每次只问一个问题，等待用户回答\n` +
      `- 如果用户不确定路径，建议常见的目录（如 ~/projects, ~/workspace, D:\\projects 等）`
    );
  }

  return (
    `You are a CC-Panes onboarding assistant. You are helping a first-time CC-Panes user.\n` +
    `Please communicate in English with a friendly and professional tone.\n\n` +
    `## Your Task\n` +
    `1. Briefly introduce the core concepts of CC-Panes:\n` +
    `   - Workspace: A collection of projects with configuration and session logs\n` +
    `   - Project: Corresponds to a Git repository or code directory\n` +
    `   - Task: A specific task under a project, displayed as a terminal tab\n\n` +
    `2. Guide the user to create their first workspace:\n` +
    `   - Ask the user for their commonly used project directory path\n` +
    `   - Use the ccpanes MCP tool scan_directory to scan the directory and discover projects\n` +
    `   - Use create_workspace to create a workspace\n` +
    `   - Use add_project_to_workspace to add discovered projects to the workspace\n\n` +
    `3. After completion, tell the user:\n` +
    `   - They can click the tree icon on the left activity bar to switch to Explorer view\n` +
    `   - Right-click a project in Explorer to launch Claude Code\n` +
    `   - They can use split-pane to manage multiple Claude Code instances simultaneously\n\n` +
    `## Available ccpanes MCP Tools\n` +
    `- scan_directory: Scan a directory to discover Git repositories and projects\n` +
    `- create_workspace: Create a new workspace\n` +
    `- add_project_to_workspace: Add a project to a workspace\n` +
    `- list_workspaces: List all workspaces\n` +
    `- list_projects: List all registered projects\n\n` +
    `## Notes\n` +
    `- Keep the conversation concise and friendly\n` +
    `- Ask one question at a time and wait for the user's response\n` +
    `- If the user is unsure about paths, suggest common directories (~/projects, ~/workspace, etc.)`
  );
}

export const selfChatService = {
  getAppCwd,
  collectAppContext,
  collectOnboardingContext,
};
