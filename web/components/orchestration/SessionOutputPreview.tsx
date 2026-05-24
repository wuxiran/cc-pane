import { useEffect, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { terminalService } from "@/services";

interface SessionOutputPreviewProps {
  sessionId?: string | null;
}

export default function SessionOutputPreview({ sessionId }: SessionOutputPreviewProps) {
  const [output, setOutput] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (!sessionId) {
        setOutput("");
        setError(null);
        return;
      }
      setLoading(true);
      try {
        const snapshot = await terminalService.getRecentOutput(sessionId, 200);
        if (!cancelled) {
          setOutput(snapshot.lines.join("\n"));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
        <Terminal className="h-8 w-8" style={{ color: "var(--app-text-tertiary)" }} />
        <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          No linked PTY session.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between px-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
        <div className="min-w-0 truncate text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
          Recent output
        </div>
        <Button variant="ghost" size="icon-xs" disabled={loading} title="Refresh output">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {error ? (
        <div className="p-3 text-xs" style={{ color: "var(--app-status-danger)" }}>
          {error}
        </div>
      ) : (
        <pre
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {output || "No output yet."}
        </pre>
      )}
    </div>
  );
}
