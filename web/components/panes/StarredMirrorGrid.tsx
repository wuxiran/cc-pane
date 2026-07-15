import { useMemo } from "react";
import StarredMirrorTile from "./StarredMirrorTile";
import {
  collectStarredMirrorTiles,
  mirrorGridClass,
  type StarredShortcutSource,
} from "./starredMirrors";

interface StarredMirrorGridProps {
  shortcuts: StarredShortcutSource[];
  onJump: (tabId: string) => void;
}

/** 星标页镜像网格：每个星标终端一个格子，自动排列。 */
export default function StarredMirrorGrid({ shortcuts, onJump }: StarredMirrorGridProps) {
  const tiles = useMemo(() => collectStarredMirrorTiles(shortcuts), [shortcuts]);
  const scrollable = tiles.length > 4;

  return (
    <div className={`min-h-0 flex-1 p-2 ${scrollable ? "overflow-y-auto" : ""}`}>
      <div className={`grid h-full gap-2 ${mirrorGridClass(tiles.length)}`}>
        {tiles.map((tile) => (
          <StarredMirrorTile key={tile.key} tile={tile} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}
