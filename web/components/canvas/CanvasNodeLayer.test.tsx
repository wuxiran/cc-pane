import { forwardRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasDisplayStore } from "@/stores/useCanvasDisplayStore";
import type { CanvasNodeProjection } from "@/types/canvas";
import CanvasNodeLayer from "./CanvasNodeLayer";

vi.mock("@/components/panes/TerminalView", () => ({
  default: forwardRef<HTMLDivElement, { cliTool?: string; layoutFitKey?: string | number; initialTerminalFontSize?: number; terminalZoomPersistenceKey?: string; resizeBackendPty?: boolean; readOnly?: boolean }>((props, _ref) => (
    <div
      data-testid="canvas-terminal-mirror"
      data-cli-tool={props.cliTool}
      data-layout-fit-key={props.layoutFitKey}
      data-initial-font-size={props.initialTerminalFontSize}
      data-zoom-persistence-key={props.terminalZoomPersistenceKey}
      data-resize-backend-pty={String(Boolean(props.resizeBackendPty))}
      data-read-only={String(Boolean(props.readOnly))}
    />
  )),
}));

const node: CanvasNodeProjection = {
  id: "binding:leader",
  label: "Leader",
  kind: "task",
  bindingId: "leader",
  role: "leader",
  status: "running",
  projectPath: "C:/project",
  sessionId: "session-1",
  cliTool: "codex",
};

describe("CanvasNodeLayer", () => {
  beforeEach(() => {
    useCanvasDisplayStore.setState({ mode: "canvas", animationIntensity: "full" });
  });

  it("renders a responsive interactive terminal card and repositions it from the drag handle", () => {
    const onPositionChange = vi.fn();
    const position = { x: 40, y: 48, width: 320, height: 220 };
    render(<CanvasNodeLayer nodes={[node]} positions={{ [node.id]: position }} viewport={{ width: 1200, height: 760 }} onPositionChange={onPositionChange} />);

    const card = screen.getByRole("article");
    expect(card).toHaveStyle({ width: "320px", height: "220px", left: "40px", top: "48px" });
    expect(card).toHaveStyle({ background: "var(--app-panel-bg-effective)" });
    expect(screen.getByTestId("canvas-terminal-mirror")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-layout-fit-key", "binding:leader:canvas:320:220");
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-cli-tool", "codex");
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-initial-font-size", "10");
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-zoom-persistence-key", "canvas-terminal:binding:leader");
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-resize-backend-pty", "true");
    expect(screen.getByTestId("canvas-terminal-mirror")).toHaveAttribute("data-read-only", "false");

    const handle = screen.getByTestId("canvas-node-handle-binding:leader");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180, clientY: 145 });

    expect(onPositionChange).toHaveBeenCalledWith("binding:leader", {
      x: 120,
      y: 93,
      width: 320,
      height: 220,
    });
  });

  it("writes resized dimensions and honors the responsive minimum", () => {
    const onPositionChange = vi.fn();
    const position = { x: 40, y: 48, width: 320, height: 220 };
    render(<CanvasNodeLayer nodes={[node]} positions={{ [node.id]: position }} viewport={{ width: 1200, height: 760 }} onPositionChange={onPositionChange} />);

    const handle = screen.getByTestId("canvas-node-resize-binding:leader");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 380, clientY: 245 });

    expect(onPositionChange).toHaveBeenCalledWith("binding:leader", {
      x: 40,
      y: 48,
      width: 400,
      height: 265,
    });
  });
});
