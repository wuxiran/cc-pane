/** A new session may use the current checkout or a new branch in an isolated worktree. */
export interface LocalWorktreeDraft {
  enabled: boolean;
  branch: string;
  /** Git commit-ish used only to create a new worktree; never checks out the source. */
  baseRef?: string;
  /** Repository that gets the worktree when the launch directory itself is not one
   * (a workspace root holding several projects). Absent = the launch directory. */
  repoPath?: string;
}
