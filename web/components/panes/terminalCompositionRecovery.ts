export interface AnimationFrameScheduler {
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}

// Keep the browser methods' receiver intact. The wrappers also defer global
// lookup until invocation, so importing this module remains safe without a
// browser global (for example during SSR).
export const defaultAnimationFrameScheduler: AnimationFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Wait for xterm and WebView2 to finish composition teardown before repairing
 * terminal layout. A new composition cancels any recovery that is still queued.
 */
export function bindTerminalCompositionRecovery(
  textarea: HTMLTextAreaElement | null | undefined,
  onCompositionChange: (isComposing: boolean) => void,
  recover: () => void,
  scheduler: AnimationFrameScheduler = defaultAnimationFrameScheduler,
): () => void {
  if (!textarea) return () => {};

  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let disposed = false;
  let compositionActive = false;

  const cancelQueuedRecovery = () => {
    if (firstFrame !== null) {
      scheduler.cancel(firstFrame);
      firstFrame = null;
    }
    if (secondFrame !== null) {
      scheduler.cancel(secondFrame);
      secondFrame = null;
    }
  };

  const handleCompositionStart = () => {
    cancelQueuedRecovery();
    compositionActive = true;
    onCompositionChange(true);
  };

  const handleCompositionEnd = () => {
    compositionActive = false;
    onCompositionChange(false);
    cancelQueuedRecovery();
    firstFrame = scheduler.request(() => {
      firstFrame = null;
      secondFrame = scheduler.request(() => {
        secondFrame = null;
        if (!disposed) recover();
      });
    });
  };

  const handleBlur = () => {
    if (compositionActive) handleCompositionEnd();
  };

  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", handleCompositionEnd);
  textarea.addEventListener("blur", handleBlur);

  return () => {
    disposed = true;
    cancelQueuedRecovery();
    textarea.removeEventListener("compositionstart", handleCompositionStart);
    textarea.removeEventListener("compositionend", handleCompositionEnd);
    textarea.removeEventListener("blur", handleBlur);
  };
}
