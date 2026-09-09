import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { serializeTerminalSnapshot, terminalSnapshotMouseEncoding } from "./terminalSnapshotModes";

const terminals: Terminal[] = [];
function createTerminal() {
  const term = new Terminal({ cols: 94, rows: 61, allowProposedApi: true });
  terminals.push(term);
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}
const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve));

afterEach(() => terminals.splice(0).forEach(term => term.dispose()));

describe("terminal snapshot mouse encoding", () => {
  it.each([1006, 1016])("preserves encoding %i across a fresh attach and a reset", async mode => {
    const source = createTerminal();
    const target = createTerminal();
    await write(source.term, `\x1b[?1049h\x1b[?1003h\x1b[?${mode}hplan`);
    const snapshot = serializeTerminalSnapshot(source.term, source.serializer);
    for (const reset of [false, true]) {
      if (reset) target.term.reset();
      await write(target.term, snapshot);
      expect(target.term.buffer.active.type).toBe("alternate");
      expect(target.term.modes.mouseTrackingMode).toBe("any");
      expect(terminalSnapshotMouseEncoding(target.term)).toBe(`\x1b[?${mode}h`);
    }
  });

  it("restored wheel reports reach onData, not the unbound binary channel", async () => {
    const source = createTerminal();
    const target = createTerminal();
    await write(source.term, "\x1b[?1049h\x1b[?1003h\x1b[?1006hplan");
    await write(target.term, serializeTerminalSnapshot(source.term, source.serializer));
    const data: string[] = [];
    const binary: string[] = [];
    target.term.onData(chunk => data.push(chunk));
    target.term.onBinary(chunk => binary.push(chunk));
    // Exercise the same xterm service used by the DOM wheel handler.
    const core = (target.term as unknown as { _core: { coreMouseService: {
      triggerMouseEvent(event: object): boolean;
    } } })._core.coreMouseService;
    core.triggerMouseEvent({ col: 10, row: 10, x: 80, y: 160, button: 4,
      action: 0, ctrl: false, alt: false, shift: false });
    expect(data).toEqual(["\x1b[<64;11;11M"]);
    expect(binary).toEqual([]);
  });

  it("preserves SGR even while reporting is disabled", async () => {
    const source = createTerminal();
    const target = createTerminal();
    await write(source.term, "\x1b[?1006h\x1b[?1003l");
    await write(target.term, serializeTerminalSnapshot(source.term, source.serializer));
    expect(target.term.modes.mouseTrackingMode).toBe("none");
    await write(target.term, "\x1b[?1003h");
    expect(terminalSnapshotMouseEncoding(target.term)).toBe("\x1b[?1006h");
  });

  it("restores default encoding without forcing SGR onto legacy applications", async () => {
    const source = createTerminal();
    const target = createTerminal();
    await write(source.term, "\x1b[?1000h");
    await write(target.term, "\x1b[?1016h");
    await write(target.term, serializeTerminalSnapshot(source.term, source.serializer));
    expect(target.term.modes.mouseTrackingMode).toBe("vt200");
    expect(terminalSnapshotMouseEncoding(target.term)).toBe("\x1b[?1006l\x1b[?1016l");
  });

  it("uses parsed state across split mode sequences and term.reset()", async () => {
    const { term } = createTerminal();
    await write(term, "\x1b[?1003;10");
    await write(term, "06h");
    expect(terminalSnapshotMouseEncoding(term)).toBe("\x1b[?1006h");
    term.reset();
    expect(terminalSnapshotMouseEncoding(term)).toBe("\x1b[?1006l\x1b[?1016l");
  });
});
