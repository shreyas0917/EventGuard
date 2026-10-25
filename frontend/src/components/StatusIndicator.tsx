interface StatusIndicatorProps {
  status: "ok" | "error" | "unknown" | "checking";
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const statusStyles = {
    ok: "bg-green-500",
    error: "bg-red-500",
    unknown: "bg-gray-500",
    checking: "bg-accent-muted animate-pulse",
  };

  const statusText = {
    ok: "Healthy",
    error: "Error",
    unknown: "Checking...",
    checking: "Checking...",
  };

  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${statusStyles[status]}`}></div>
      <span className="text-sm text-text-secondary">{statusText[status]}</span>
    </div>
  );
}
