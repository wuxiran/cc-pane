/**
 * Frontend counterpart of `cc-panes-core::utils::project_identity`.
 *
 * This value is only a comparison key. Never persist it or use it as a launch path.
 */
export function projectIdentityKey(path: string): string {
  const canonical = canonicalProjectPath(path);
  return isWindowsDrivePath(canonical) ? canonical.toLowerCase() : canonical;
}

export function projectPathsEquivalent(a: string, b: string): boolean {
  return projectIdentityKey(a) === projectIdentityKey(b);
}

function canonicalProjectPath(path: string): string {
  if (path.slice(0, 6).toLowerCase() === "ssh://") return path;

  const slashPath = normalizeProjectPath(path).replace(/\\/g, "/");
  return canonicalWindowsDrivePath(slashPath)
    ?? canonicalMountedDrivePath(slashPath)
    ?? canonicalWslUncPath(slashPath)
    ?? (slashPath.startsWith("//") ? slashPath.replace(/\//g, "\\") : slashPath);
}

function normalizeProjectPath(path: string): string {
  let value = stripVerbatimDrivePrefix(path);
  if (isWindowsDrivePath(value)) {
    value = `${value[0].toUpperCase()}${value.slice(1)}`;
  }
  return trimTrailingSeparators(value);
}

function stripVerbatimDrivePrefix(path: string): string {
  const rest = path.startsWith("\\\\?\\")
    ? path.slice(4)
    : path.startsWith("//?/")
      ? path.slice(4)
      : null;
  return rest && isWindowsDrivePath(rest) ? rest : path;
}

function trimTrailingSeparators(path: string): string {
  if (!path || isUncShareRoot(path)) return path;
  const isDriveRoot = isWindowsDrivePath(path) && isSeparator(path[2]);
  const minimumLength = path.startsWith("/") || path.startsWith("\\")
    ? 1
    : isDriveRoot
      ? 3
      : 0;
  let end = path.length;
  while (end > minimumLength && isSeparator(path[end - 1])) end -= 1;
  return path.slice(0, end);
}

function isUncShareRoot(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith("//") || normalized.startsWith("//?/")) return false;
  return normalized
    .replace(/\/+$/, "")
    .slice(2)
    .split("/")
    .length === 2;
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path);
}

function isSeparator(value: string | undefined): boolean {
  return value === "/" || value === "\\";
}

function canonicalWindowsDrivePath(path: string): string | null {
  if (!isWindowsDrivePath(path)) return null;
  const drive = path[0].toUpperCase();
  const rest = path.slice(2);
  if (!rest) return `${drive}:`;
  if (!rest.startsWith("/")) return null;
  return formatDrivePath(drive, rest.replace(/^\/+/, ""));
}

function canonicalMountedDrivePath(path: string): string | null {
  if (!path.startsWith("/mnt/")) return null;
  const rest = path.slice(5);
  if (!/^[A-Za-z](?:\/|$)/.test(rest)) return null;
  return formatDrivePath(rest[0].toUpperCase(), rest.slice(1).replace(/^\/+/, ""));
}

function canonicalWslUncPath(path: string): string | null {
  if (!path.startsWith("//")) return null;
  const [server, distro, ...remaining] = path.slice(2).split("/");
  if (!server || !distro || !isWslServer(server)) return null;

  const remoteParts = remaining.filter(Boolean);
  if (
    remoteParts[0] === "mnt"
    && remoteParts[1]
    && /^[A-Za-z]$/.test(remoteParts[1])
  ) {
    return formatDrivePath(
      remoteParts[1].toUpperCase(),
      remoteParts.slice(2).join("/"),
    );
  }

  return ["", "", "wsl.localhost", distro, ...remoteParts].join("\\");
}

function isWslServer(server: string): boolean {
  const normalized = server.toLowerCase();
  return normalized === "wsl.localhost" || normalized === "wsl$" || normalized === "wsl";
}

function formatDrivePath(drive: string, tail: string): string {
  const normalizedTail = tail.replace(/^\/+|\/+$/g, "");
  return normalizedTail
    ? `${drive}:\\${normalizedTail.replace(/\//g, "\\")}`
    : `${drive}:\\`;
}
