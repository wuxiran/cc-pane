import type { WorktreeInfo } from "@/services";
import type { WorkspaceProject } from "@/types";
import { projectIdentityKey, projectPathsEquivalent } from "@/utils/projectIdentity";

/**
 * 把工作空间的扁平项目列表派生成「主仓库 → worktree 子节点」的两层结构。
 *
 * 关系完全运行时派生自 `git worktree list`，不落盘：worktree 被删/移动后自动自愈，
 * 无需迁移字段。
 *
 * 关键点：**不能**把「A 的 worktree 列表里有 B」当成「B 是 A 的子节点」——
 * `git worktree list` 从任何一个 worktree 跑都返回同一份全量列表，那样会互认成环。
 * 这里只把列表当作**分组键**：同一 repo 的所有项目（含主仓库自己）算出同一个 repoKey，
 * 父节点唯一确定为 `identityKey(自身路径) === repoKey` 的那一个。结构上深度恒为 1、不可能成环。
 */
export interface WorktreeChild {
  project: WorkspaceProject;
  branch: string;
}

export interface WorktreeGroup {
  repoKey: string;
  parent: WorkspaceProject;
  children: WorktreeChild[];
}

export type ProjectTreeNode =
  | { kind: "single"; project: WorkspaceProject }
  | { kind: "group"; group: WorktreeGroup };

interface ClassifiedProject {
  project: WorkspaceProject;
  index: number;
  repoKey: string;
  isMain: boolean;
  branch: string;
}

/**
 * 判定单个项目属于哪个 repo 分组。返回 null 表示「保持顶层平铺」。
 */
function classifyProject(
  project: WorkspaceProject,
  index: number,
  entries: WorktreeInfo[] | undefined,
): ClassifiedProject | null {
  // SSH 远程项目不参与 worktree 分组
  if (project.ssh) return null;
  // 缓存未就绪、路径不存在、非 Git 仓库都落这里
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const mainEntry = entries.find((entry) => entry.isMain && entry.path);
  if (!mainEntry) return null;

  // 守卫：项目自身路径必须是一条已注册的 worktree 根。少了这条，monorepo 子目录项目
  // （如 D:\repo\packages\api，从它跑 git worktree list 同样返回 D:\repo 作为 main）
  // 会被误认成假 worktree 子节点。
  const selfEntry = entries.find((entry) => projectPathsEquivalent(entry.path, project.path));
  if (!selfEntry) return null;

  return {
    project,
    index,
    repoKey: projectIdentityKey(mainEntry.path),
    isMain: selfEntry.isMain,
    branch: selfEntry.branch ?? "",
  };
}

interface RepoBucket {
  order: number;
  parent: ClassifiedProject | null;
  children: ClassifiedProject[];
}

/**
 * @param worktreeCache 按 project.path 索引的 `git worktree list` 结果
 * @returns 顶层节点列表，顺序按各节点在 `projects` 中首次出现的位置，
 *          保证不因缓存到达顺序抖动
 */
export function buildProjectTree(
  projects: WorkspaceProject[],
  worktreeCache: Record<string, WorktreeInfo[]>,
): ProjectTreeNode[] {
  const buckets = new Map<string, RepoBucket>();
  const ordered: Array<{ order: number; node: ProjectTreeNode }> = [];
  const pushSingle = (order: number, project: WorkspaceProject) => {
    ordered.push({ order, node: { kind: "single", project } });
  };

  projects.forEach((project, index) => {
    const classified = classifyProject(project, index, worktreeCache[project.path]);
    if (!classified) {
      pushSingle(index, project);
      return;
    }

    let bucket = buckets.get(classified.repoKey);
    if (!bucket) {
      bucket = { order: index, parent: null, children: [] };
      buckets.set(classified.repoKey, bucket);
    }

    if (!classified.isMain) {
      bucket.children.push(classified);
      return;
    }
    // 同一主仓库被重复注册时保留后来者做父节点，前一条降级为顶层——绝不静默吞掉任何项目
    if (bucket.parent) pushSingle(bucket.parent.index, bucket.parent.project);
    bucket.parent = classified;
  });

  for (const [repoKey, bucket] of buckets) {
    // 主仓库没被加进工作空间：不让某个 worktree 冒充父节点（右键「Worktree 管理」
    // 会以错误的 repo root 打开），全部退回顶层平铺
    if (!bucket.parent) {
      for (const child of bucket.children) pushSingle(child.index, child.project);
      continue;
    }
    if (bucket.children.length === 0) {
      pushSingle(bucket.parent.index, bucket.parent.project);
      continue;
    }
    ordered.push({
      order: bucket.order,
      node: {
        kind: "group",
        group: {
          repoKey,
          parent: bucket.parent.project,
          children: bucket.children.map((child) => ({
            project: child.project,
            branch: child.branch,
          })),
        },
      },
    });
  }

  ordered.sort((a, b) => a.order - b.order);
  return ordered.map((entry) => entry.node);
}
