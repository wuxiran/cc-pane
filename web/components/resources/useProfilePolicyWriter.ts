// 启动档开关的写入器：点击立即显示，同一启动档串行写入，连点合并成下一次写入。
// 接口是整份启动档覆盖式的，并发写会互相吃掉改动，所以每次写都基于 store 里最新的启动档重放操作。
import { useCallback, useEffect, useRef, useState } from "react";
import { toDraft } from "@/components/providers/launchProfileHelpers";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import type { LaunchProfileDraft } from "@/types";

export type DraftOp = (draft: LaunchProfileDraft) => LaunchProfileDraft;

interface Channel {
  ops: DraftOp[];
  writing: boolean;
}

export function useProfilePolicyWriter(onError: (error: unknown) => void) {
  const [overlay, setOverlay] = useState<Record<string, LaunchProfileDraft>>({});
  const channels = useRef(new Map<string, Channel>());
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const clearOverlay = useCallback((profileId: string) => {
    setOverlay((current) => {
      if (!(profileId in current)) return current;
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  }, []);

  const flush = useCallback(
    async (profileId: string, channel: Channel) => {
      if (channel.writing) return;
      channel.writing = true;
      try {
        while (channel.ops.length > 0) {
          const ops = channel.ops.splice(0);
          const { profiles, update } = useLaunchProfilesStore.getState();
          const profile = profiles.find((item) => item.id === profileId);
          if (!profile) break;
          await update(profileId, ops.reduce((draft, op) => op(draft), toDraft(profile)));
        }
      } catch (error) {
        // 失败时丢弃排队的改动：它们基于用户刚看到的乐观状态，再写只会让界面和后端继续不一致
        channel.ops.length = 0;
        onErrorRef.current(error);
      } finally {
        channel.writing = false;
        clearOverlay(profileId);
      }
    },
    [clearOverlay],
  );

  const apply = useCallback(
    (profileId: string, op: DraftOp) => {
      const profile = useLaunchProfilesStore.getState().profiles.find((item) => item.id === profileId);
      if (!profile) return;
      setOverlay((current) => ({ ...current, [profileId]: op(current[profileId] ?? toDraft(profile)) }));
      let channel = channels.current.get(profileId);
      if (!channel) {
        channel = { ops: [], writing: false };
        channels.current.set(profileId, channel);
      }
      channel.ops.push(op);
      void flush(profileId, channel);
    },
    [flush],
  );

  return { overlay, apply };
}
