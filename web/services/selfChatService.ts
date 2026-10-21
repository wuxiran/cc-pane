/**
 * Self-Chat 服务
 *
 * 提供应用级上下文收集（工作空间、Todo、可用 Skill），
 * 以及 getAppCwd() 获取 CC-Panes 项目根目录。
 */
import { useWorkspacesStore } from "@/stores";
import { todoService } from "./todoService";
import { apiGet, invokeOrApi } from "./apiClient";
import { SELF_CHAT_CTL_SCHEMA, SELF_CHAT_CTL_CALL } from "./selfChatCtlCommands";

/** 获取应用当前工作目录 */
async function getAppCwd(): Promise<string> {
  return invokeOrApi<string>("get_app_cwd", undefined, () =>
    apiGet<string>("/api/runtime/cwd"),
  );
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
    `你可以使用上面列出的 /ccbook:* skill 来管理 Todo、Plans 和多 Agent 工作流。\n\n` +
    `你拥有 ccpanes MCP core 工具：\n` +
    `- 编排: dispatch_task（启动并持久化任务）、list_panes、list_projects、get_task_status、list_sessions、get_session_status、get_session_output、wait_for_session、submit_to_session、kill_session\n` +
    `- 编排关系: register_plan_leader、register_plan_worker、report_to_leader、send_to_worker、reconcile_plan_collaboration、get_plan_collaboration\n` +
    `- 待办: query_todos、create_todo、update_todo\n` +
    `- 只读发现: list_workspaces、get_workspace、list_resume_sessions、list_launch_history、list_skills\n` +
    `管理写操作（工作空间、项目、运行配置、项目 MCP、共享 MCP、文件和 runner）不在会话 MCP 中；需要时加载 /ccbook:ccpanes-admin，再使用 ${SELF_CHAT_CTL_SCHEMA} 查看 schema，最后使用 ${SELF_CHAT_CTL_CALL}。替换 <tool> 和 <args> 为实际工具名及 JSON 参数。\n\n` +
    `典型场景：用户要执行任务时先用 list_projects 核对，再用 dispatch_task 持久化派发；用 get_task_status/wait_for_session 验收。管理操作按 ccpanes-admin 的 ctl schema 执行，不要臆造已移出的 MCP 工具。\n` +
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
      `2. 引导用户接入第一个工作空间：\n` +
      `   - 询问用户常用的项目目录路径\n` +
      `   - 加载 /ccbook:ccpanes-admin，先使用 ${SELF_CHAT_CTL_SCHEMA} 查看 schema，再用 ${SELF_CHAT_CTL_CALL} 执行 scan_directory、create_workspace、add_project_to_workspace；替换 <tool> 和 <args> 为实际值\n` +
      `   - 调用前先用 list_workspaces/list_projects 核对现状，避免重复创建\n\n` +
      `3. 完成后告诉用户：\n` +
      `   - 可以点击左侧活动栏的树形图标切换到 Explorer 视图\n` +
      `   - 在 Explorer 中右键项目可以启动 Claude Code\n` +
      `   - 可以通过分屏功能同时管理多个 Claude Code 实例\n\n` +
      `## 可用能力\n` +
      `- MCP core 提供只读发现；管理写操作通过 /ccbook:ccpanes-admin 与 \"$CC_PANES_CTL\" tools/call。\n` +
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
    `2. Guide the user to connect their first workspace:\n` +
    `   - Ask for the project directory path\n` +
    `   - Load /ccbook:ccpanes-admin, inspect ${SELF_CHAT_CTL_SCHEMA}, then use ${SELF_CHAT_CTL_CALL} for scan_directory, create_workspace and add_project_to_workspace; replace <tool> and <args> with the actual tool and JSON arguments\n` +
    `   - Check existing workspaces and projects before writing\n\n` +
    `3. After completion, tell the user:\n` +
    `   - They can click the tree icon on the left activity bar to switch to Explorer view\n` +
    `   - Right-click a project in Explorer to launch Claude Code\n` +
    `   - They can use split-pane to manage multiple Claude Code instances simultaneously\n\n` +
    `## Available capabilities\n` +
    `- MCP core provides read-only discovery; management writes use /ccbook:ccpanes-admin and \"$CC_PANES_CTL\" tools/call.\n` +
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
