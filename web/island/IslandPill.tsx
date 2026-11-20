import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { IslandPosition, IslandSession } from "@/types/island";
import { IslandCheck, IslandFace, IslandNeedsDot, IslandSpinner } from "./IslandIcons";
import { formatElapsed, type CollapsedView } from "./islandView";

interface IslandPillProps {
  view: CollapsedView;
  edge: IslandPosition;
  now: number;
}

function sessionLabel(t: TFunction<"island">, key: "needsYou" | "doneTitle", session: IslandSession) {
  return session.cli
    ? t(key, { name: session.name, cli: session.cli })
    : t(key === "needsYou" ? "needsYouNoCli" : "doneTitleNoCli", { name: session.name });
}

/** 收起态：顶部横向胶囊。宽度随内容伸缩（窗口尺寸由外层上报）。 */
function TopPill({ view, now }: { view: CollapsedView; now: number }) {
  const { t } = useTranslation("island");
  switch (view.kind) {
    case "idle":
      return (
        <div className="island-pill" data-tone="idle">
          <IslandFace />
          <span className="island-muted">{t("idle")}</span>
        </div>
      );
    case "running":
      return (
        <div className="island-pill" data-tone="running">
          <IslandSpinner />
          <span>{t("runningCount", { count: view.count })}</span>
          <span className="island-muted island-mono">{formatElapsed(now - view.longestSince)}</span>
        </div>
      );
    case "needs":
      return (
        <div className="island-pill" data-tone="needs">
          <IslandNeedsDot />
          <span>{sessionLabel(t, "needsYou", view.session)}</span>
          <span className="island-count">{view.count}</span>
          {view.running > 0 ? (
            <>
              <span className="island-divider" />
              <span className="island-muted">{t("moreRunning", { count: view.running })}</span>
            </>
          ) : null}
        </div>
      );
    case "done":
      return (
        <div className="island-pill" data-tone="done">
          <IslandCheck />
          <span>{sessionLabel(t, "doneTitle", view.session)}</span>
          {view.session.activity ? <span className="island-muted island-ellipsis" style={{ maxWidth: 220 }}>{view.session.activity}</span> : null}
        </div>
      );
  }
}

/** 左 / 右侧竖胶囊：状态点 + 运行数。 */
function SidePill({ view, edge }: { view: CollapsedView; edge: IslandPosition }) {
  const running = view.kind === "running" ? view.count : view.kind === "needs" ? view.running : 0;
  return (
    <div className="island-side" data-edge={edge} data-tone={view.kind}>
      {view.kind === "idle" ? <IslandFace /> : null}
      {view.kind === "needs" ? <IslandNeedsDot /> : null}
      {view.kind === "done" ? <IslandCheck /> : null}
      {running > 0 ? <IslandSpinner /> : null}
      {running > 0 ? <span className="island-mono" style={{ fontSize: 11, color: "var(--island-dim)" }}>{running}</span> : null}
    </div>
  );
}

export default function IslandPill({ view, edge, now }: IslandPillProps) {
  return edge === "top" ? <TopPill view={view} now={now} /> : <SidePill view={view} edge={edge} />;
}

/** 全屏避让：3px 细线；有「需要你」时琥珀色。 */
export function IslandLine({ edge, needs }: { edge: IslandPosition; needs: boolean }) {
  return <div className="island-line" data-edge={edge} data-tone={needs ? "needs" : "idle"} />;
}
