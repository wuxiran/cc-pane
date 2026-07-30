import { terminalService } from "@/services";

let cachedBuildNumber: number | null = null;
let buildNumberPromise: Promise<number> | null = null;

/** Cache the Windows build number once per renderer process. */
export async function getCachedWindowsBuildNumber(): Promise<number> {
  if (cachedBuildNumber !== null) return cachedBuildNumber;
  if (!buildNumberPromise) {
    buildNumberPromise = terminalService.getWindowsBuildNumber()
      .then((num) => { cachedBuildNumber = num; return num; })
      .catch(() => { cachedBuildNumber = 0; return 0; });
  }
  return buildNumberPromise;
}
