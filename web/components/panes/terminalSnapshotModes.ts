interface SnapshotTerminalInternals {
  _core?: { coreMouseService?: { activeEncoding: string } };
}

/** SerializeAddon saves mouse tracking, but omits the independent wire encoding. */
export function terminalSnapshotMouseEncoding(term: object): string {
  // xterm has no public mouse-encoding getter. Keep this dependency isolated
  // and covered by real-xterm round-trip tests when upgrading xterm.
  const mouse = (term as SnapshotTerminalInternals)._core?.coreMouseService;
  if (!mouse) return "";
  switch (mouse.activeEncoding) {
    case "SGR": return "\x1b[?1006h";
    case "SGR_PIXELS": return "\x1b[?1016h";
    case "DEFAULT": return "\x1b[?1006l\x1b[?1016l";
    default: throw new Error(`Unsupported terminal mouse encoding: ${mouse.activeEncoding}`);
  }
}

export function serializeTerminalSnapshot(term: object, serializer: { serialize(): string }): string {
  return serializer.serialize() + terminalSnapshotMouseEncoding(term);
}
