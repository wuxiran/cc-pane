export type BrowserSecurityKind = "secure" | "local" | "insecure";

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.endsWith(".localhost")
    || isPrivateIpv4(normalized)
    || (!normalized.includes(".") && !normalized.includes(":"));
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Browser URL is required");

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^[^/]+:\d+(?:\/|$)/.test(candidate)) {
      throw new Error("Browser tabs only support http and https URLs");
    }
    const authority = candidate.split("/", 1)[0];
    const hostname = authority.replace(/^\[/, "").replace(/\]$/, "").split(":", 1)[0];
    candidate = `${isLocalHostname(hostname) ? "http" : "https"}://${candidate}`;
  }

  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser tabs only support http and https URLs");
  }
  return url.toString();
}

export function browserSecurityKind(value: string): BrowserSecurityKind {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return "secure";
    if (url.protocol === "http:" && isLocalHostname(url.hostname)) return "local";
  } catch {
    return "insecure";
  }
  return "insecure";
}
