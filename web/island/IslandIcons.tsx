// 灵动岛用的小图标：cc 脸、运行中蓝色转圈、完成绿勾、需要你琥珀点。
export function IslandFace() {
  return (
    <span className="island-face" aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

export function IslandSpinner() {
  return (
    <svg className="island-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--island-blue)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

export function IslandCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--island-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IslandNeedsDot() {
  return <span className="island-dot island-pulse" aria-hidden="true" />;
}
