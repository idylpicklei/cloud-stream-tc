interface StatusBadgeProps {
  live: boolean;
  label?: string;
}

export function StatusBadge({ live, label }: StatusBadgeProps) {
  return (
    <span className={`status-badge${live ? " is-live" : ""}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {label ?? (live ? "Live" : "Offline")}
    </span>
  );
}
