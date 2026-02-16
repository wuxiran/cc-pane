export default function AboutSection() {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        关于
      </h3>

      <div className="flex flex-col gap-2">
        {([
          ["应用名称", "CC-Panes"],
          ["版本", "0.1.0"],
          ["描述", "Claude Code 多实例分屏管理"],
          ["技术栈", "Tauri 2 + React 19 + TypeScript"],
        ] as const).map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between items-center py-1.5"
            style={{ borderBottom: "1px solid var(--app-border)" }}
          >
            <span className="text-[13px]" style={{ color: "var(--app-text-secondary)" }}>{label}</span>
            <span className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
