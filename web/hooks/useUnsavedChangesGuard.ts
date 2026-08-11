import { useCallback, useEffect, useRef, useState } from "react";

export function useUnsavedChangesGuard(
  isDirty: boolean,
  onDiscard?: () => void,
) {
  const pendingActionRef = useRef<(() => void) | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const request = useCallback((action: () => void) => {
    if (!isDirty) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setConfirmOpen(true);
  }, [isDirty]);

  const cancel = useCallback(() => {
    pendingActionRef.current = null;
    setConfirmOpen(false);
  }, []);

  const discard = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setConfirmOpen(false);
    onDiscard?.();
    action?.();
  }, [onDiscard]);

  // A save or a parent navigation can clear dirty state while the dialog is
  // open. Do not retain an action that no longer belongs to the current view.
  useEffect(() => {
    if (isDirty) return;
    pendingActionRef.current = null;
    setConfirmOpen(false);
  }, [isDirty]);

  useEffect(() => () => {
    pendingActionRef.current = null;
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  return { confirmOpen, request, cancel, discard };
}
