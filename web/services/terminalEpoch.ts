/** Epoch is an identity, never a JavaScript arithmetic value. */
export function normalizeCheckpointEpoch(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) return null;
  return BigInt(value) <= 18_446_744_073_709_551_615n ? value : null;
}
