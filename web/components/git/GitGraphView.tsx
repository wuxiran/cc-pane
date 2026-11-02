// Git history topology view (F3.1).
//
// Renders `get_log` commits as a lane-based graph gutter plus commit summary and
// semantic ref badges. All topology math lives in ./gitGraph (pure, unit-tested);
// this module only paints it and keeps lanes visually continuous across rows.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Copy, GitBranch, GitCommitHorizontal, GitMerge, Tag } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { GitCommit } from "@/services/gitService";
import { buildGitGraph, type GitGraph, type GitRef } from "./gitGraph";

const ROW_HEIGHT = 48;
const LANE_WIDTH = 16;
const GUTTER_PAD = 10;

// Lane colours are categorical encodings of independent tracks, drawn from the
// theme tag palette so they follow light/dark and every preset automatically.
const LANE_COLORS = [
  "var(--app-accent)",
  "var(--app-status-success)",
  "var(--app-status-warning)",
  "var(--app-tag-purple)",
  "var(--app-tag-cyan)",
  "var(--app-tag-pink)",
  "var(--app-status-danger)",
  "var(--app-tag-blue)",
] as const;

function laneColor(lane: number): string {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

function gutterWidth(laneCount: number): number {
  return GUTTER_PAD * 2 + Math.max(1, laneCount) * LANE_WIDTH;
}

function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface GraphGutterProps {
  laneCount: number;
  lane: number;
  passThroughLanes: number[];
  enterLanes: number[];
  exitLanes: number[];
  hasIncoming: boolean;
  hasOutgoing: boolean;
  kind: "root" | "normal" | "merge";
  isHead: boolean;
  conflict: boolean;
}

/** SVG gutter for one commit row: pass-through tracks, bends, and the node dot. */
function GraphGutter(props: GraphGutterProps) {
  const width = gutterWidth(props.laneCount);
  const x = laneX(props.lane);
  const mid = ROW_HEIGHT / 2;
  const color = laneColor(props.lane);

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="shrink-0"
      aria-hidden="true"
      data-testid="git-graph-gutter"
    >
      {props.passThroughLanes.map((lane) => (
        <line
          key={`pass-${lane}`}
          x1={laneX(lane)}
          x2={laneX(lane)}
          y1={0}
          y2={ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0.7}
        />
      ))}

      {props.hasIncoming && (
        <line x1={x} x2={x} y1={0} y2={mid} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      )}
      {props.hasOutgoing && (
        <line x1={x} x2={x} y1={mid} y2={ROW_HEIGHT} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      )}

      {/* Tracks converging into this commit (e.g. the second branch of a merge base). */}
      {props.enterLanes.map((lane) => (
        <path
          key={`enter-${lane}`}
          d={`M ${laneX(lane)} 0 C ${laneX(lane)} ${mid * 0.7}, ${x} ${mid * 0.3}, ${x} ${mid}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}

      {/* Merge parents bending out of this commit into their own lanes. */}
      {props.exitLanes.map((lane) => (
        <path
          key={`exit-${lane}`}
          d={`M ${x} ${mid} C ${x} ${ROW_HEIGHT - mid * 0.3}, ${laneX(lane)} ${ROW_HEIGHT - mid * 0.7}, ${laneX(lane)} ${ROW_HEIGHT}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}

      {props.conflict && (
        <circle
          cx={x}
          cy={mid}
          r={7}
          fill="none"
          stroke="var(--app-status-danger)"
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      )}

      {props.kind === "merge" ? (
        <>
          <circle cx={x} cy={mid} r={4.5} fill="var(--app-panel-bg)" stroke={color} strokeWidth={2} />
          <circle cx={x} cy={mid} r={1.5} fill={color} />
        </>
      ) : (
        <circle
          cx={x}
          cy={mid}
          r={props.isHead ? 4.5 : 3.5}
          fill={color}
          stroke={props.isHead ? "var(--app-text-primary)" : "none"}
          strokeWidth={props.isHead ? 1 : 0}
        />
      )}
    </svg>
  );
}

interface RefBadgeProps {
  gitRef: GitRef;
}

/** Branch / tag / remote chip with a distinct icon per ref class. */
function RefBadge({ gitRef }: RefBadgeProps) {
  const { t } = useTranslation("dialogs");
  if (gitRef.kind === "tag") {
    return (
      <span
        className="flex min-w-0 items-center gap-1 rounded border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-1 py-px text-[length:var(--text-micro)] leading-none text-[var(--app-status-warning)]"
        title={t("gitGraph.tag")}
      >
        <Tag className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{gitRef.name}</span>
      </span>
    );
  }

  const isRemote = gitRef.kind === "remoteBranch";
  return (
    <span
      className={`flex min-w-0 items-center gap-1 rounded border px-1 py-px text-[length:var(--text-micro)] leading-none ${
        gitRef.isHead
          ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] font-semibold text-[var(--app-accent)]"
          : isRemote
            ? "border-[var(--app-border)] bg-transparent text-[var(--app-text-tertiary)]"
            : "border-[var(--app-status-success-border)] bg-[var(--app-status-success-bg)] text-[var(--app-status-success)]"
      }`}
      title={isRemote ? t("gitGraph.remoteBranch") : t("gitGraph.localBranch")}
    >
      {isRemote ? <Cloud className="h-2.5 w-2.5 shrink-0" /> : <GitBranch className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{gitRef.name}</span>
    </span>
  );
}

export interface GitGraphViewProps {
  commits: readonly GitCommit[];
  selectedHash: string | null;
  onSelect: (commit: GitCommit) => void;
  /** Commit hashes to mark as conflict-related (e.g. an in-progress merge tip). */
  conflictHashes?: ReadonlySet<string>;
  /** Remote names for ref classification; defaults to origin/upstream + auto-detect. */
  remotes?: readonly string[];
}

export default function GitGraphView({
  commits,
  selectedHash,
  onSelect,
  conflictHashes,
  remotes,
}: GitGraphViewProps) {
  const { t } = useTranslation("dialogs");
  const graph: GitGraph = useMemo(
    () => buildGitGraph(commits, { conflictHashes, remotes }),
    [commits, conflictHashes, remotes],
  );

  return (
    <div className="flex w-full flex-col" data-testid="git-graph-view">
      {graph.nodes.map((node) => {
        const selected = selectedHash === node.commit.hash;
        return (
          <ContextMenu key={node.commit.hash}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(node.commit)}
                aria-current={selected ? "true" : undefined}
                data-testid={`git-graph-row-${node.commit.shortHash}`}
                data-kind={node.kind}
                data-conflict={node.conflict ? "true" : undefined}
                className={`flex w-full items-center gap-2 border-b px-2 text-left hover:bg-[var(--app-hover)] ${
                  selected ? "bg-[var(--app-active-bg)]" : ""
                }`}
                style={{ height: ROW_HEIGHT }}
                title={node.commit.subject}
              >
                <GraphGutter
                  laneCount={graph.laneCount}
                  lane={node.lane}
                  passThroughLanes={node.passThroughLanes}
                  enterLanes={node.enterLanes}
                  exitLanes={node.exitLanes}
                  hasIncoming={node.hasIncoming}
                  hasOutgoing={node.hasOutgoing}
                  kind={node.kind}
                  isHead={node.isHead}
                  conflict={node.conflict}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {node.kind === "merge" && (
                      <GitMerge
                        className="h-3 w-3 shrink-0 text-[var(--app-text-tertiary)]"
                        aria-label={t("gitGraph.mergeCommit")}
                      />
                    )}
                    <span className="min-w-0 truncate text-xs font-medium text-[var(--app-text-primary)]">
                      {node.commit.subject}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <code className="shrink-0 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                      {node.commit.shortHash}
                    </code>
                    {node.refs.slice(0, 3).map((gitRef) => (
                      <RefBadge key={gitRef.raw} gitRef={gitRef} />
                    ))}
                    <span className="ml-auto shrink-0 truncate text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                      {shortDate(node.commit.date)}
                    </span>
                  </span>
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem onSelect={() => onSelect(node.commit)}>
                <GitCommitHorizontal size={14} />
                {t("gitTimeline.viewChanges")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(node.commit.hash)}>
                <Copy size={14} />
                {t("gitTimeline.copyHash")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
