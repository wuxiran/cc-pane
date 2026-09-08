import { registerSessionScopedResource } from "@/lib/tabLifecycle/sessionScopedResources";

interface RecoveryMetrics {
  checkpointResult: string;
  checkpointAccepted: number;
  checkpointRejected: number;
  checkpointSkipped: number;
  recoveryReason: string;
  recoveryDurationMs: number;
}
const records = new Map<string, RecoveryMetrics>();
const empty = (): RecoveryMetrics => ({ checkpointResult: "none", checkpointAccepted: 0,
  checkpointRejected: 0, checkpointSkipped: 0, recoveryReason: "none", recoveryDurationMs: 0 });
function entry(id: string): RecoveryMetrics {
  const value = records.get(id) ?? empty();
  records.delete(id); records.set(id, value);
  if (records.size > 128) records.delete(records.keys().next().value!);
  return value;
}
export function noteCheckpointResult(id: string, result: string): void {
  const value = entry(id);
  value.checkpointResult = result.slice(0, 80);
  if (result === "uploaded") value.checkpointAccepted++;
  else if (result.startsWith("rejected")) value.checkpointRejected++;
  else value.checkpointSkipped++;
}
export function noteRecoveryDuration(id: string, reason: string, milliseconds: number): void {
  Object.assign(entry(id), { recoveryReason: reason.slice(0, 80),
    recoveryDurationMs: Math.min(86_400_000, Math.max(0, milliseconds)) });
}
export function getRecoveryMetrics(id: string | null): RecoveryMetrics {
  return { ...(id ? records.get(id) : undefined) ?? empty() };
}
registerSessionScopedResource({ name: "performanceRecovery", dispose: id => { records.delete(id); } });
