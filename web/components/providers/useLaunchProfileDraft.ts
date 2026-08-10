import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { LaunchProfileDraft } from "@/types";

type DraftUpdater = Dispatch<SetStateAction<LaunchProfileDraft>>;

export function useLaunchProfileDraft(initializer: () => LaunchProfileDraft) {
  const userEditedRef = useRef(false);
  const [draft, setDraft] = useState(initializer);
  const markDraftEdited = useCallback<DraftUpdater>((next) => {
    userEditedRef.current = true;
    setDraft(next);
  }, []);
  const replaceDraft = useCallback<DraftUpdater>((next) => {
    userEditedRef.current = false;
    setDraft(next);
  }, []);

  return { draft, setDraft: markDraftEdited, replaceDraft, userEditedRef };
}
