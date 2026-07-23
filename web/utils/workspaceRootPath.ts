import type { Workspace } from "@/types";

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^\/+$/u.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/u.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/u, "");
}

function pathRoot(path: string): string {
  const drive = path.match(/^([A-Za-z]:)(?:\/|$)/u)?.[1];
  if (drive) return drive.toLowerCase();
  const unc = path.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/u);
  if (unc) return `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`;
  return path.startsWith("/") ? "/" : "";
}

function equalSegment(left: string, right: string, index: number): boolean {
  if (index === 0 && /^[A-Za-z]:$/u.test(left) && /^[A-Za-z]:$/u.test(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/** 解析 Files 视图使用的工作空间单根目录。 */
export function resolveWorkspaceRootPath(
  workspace: Pick<Workspace, "path" | "projects">,
): string | null {
  if (workspace.path) return normalizePath(workspace.path);

  const projectPaths = workspace.projects
    .map((project) => normalizePath(project.path))
    .filter(Boolean);
  const firstPath = projectPaths[0];
  if (!firstPath) return null;
  if (projectPaths.length === 1) return firstPath;

  const firstRoot = pathRoot(firstPath);
  if (projectPaths.some((path) => pathRoot(path) !== firstRoot)) return firstPath;

  const segments = projectPaths.map((path) => path.split("/"));
  let commonLength = segments[0].length;
  for (const parts of segments.slice(1)) {
    commonLength = Math.min(commonLength, parts.length);
    let index = 0;
    while (index < commonLength && equalSegment(segments[0][index], parts[index], index)) {
      index += 1;
    }
    commonLength = index;
    if (commonLength === 0) return firstPath;
  }

  const commonPath = segments[0].slice(0, commonLength).join("/");
  if (commonPath) return commonPath;
  return firstPath.startsWith("/") ? "/" : firstPath;
}
