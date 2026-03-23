import ProcessMonitorSection from "@/components/sidebar/ProcessMonitorSection";

export default function ProcessView() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          PROCESSES
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ProcessMonitorSection />
      </div>
    </div>
  );
}
