import {
  captureAndUploadCheckpoint,
  type CheckpointSerializer,
  type CheckpointTerminal,
} from "./terminalCheckpointUpload";

const sources = new WeakMap<object, {
  term: CheckpointTerminal; serializer: CheckpointSerializer; canUpload: () => boolean;
}>();

/** Only primary views register; a mirror's local size must not become the shared snapshot. */
export function registerRecoveryCheckpointSource(
  term: CheckpointTerminal,
  serializer: CheckpointSerializer,
  canUpload: () => boolean = () => true,
): void {
  sources.set(term, { term, serializer, canUpload });
}

export function unregisterRecoveryCheckpointSource(term: object): void {
  sources.delete(term);
}

/** Save parsed final state immediately after reanchoring, before releasing live output. */
export function checkpointRecoveredTerminal(term: object, sessionId: string): void {
  const source = sources.get(term);
  if (!source || !source.canUpload()) return;
  // Serialization and anchor capture happen synchronously before the upload's first await.
  // Existing epoch/in-flight/debounce guards still apply; unsupported backends remain safe.
  void captureAndUploadCheckpoint(sessionId, source.term, source.serializer, { reason: "recovery.complete" });
}
