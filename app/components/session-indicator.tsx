interface SessionIndicatorProps {
  active: boolean;
  checking?: boolean;
  onRequestSetup?: () => void;
}

export function SessionIndicator({
  active,
  checking = false,
  onRequestSetup,
}: SessionIndicatorProps) {
  const state = checking ? "checking" : active ? "active" : "inactive";
  const label = checking
    ? "Checking session"
    : active
      ? "Session active"
      : "Session inactive";

  const content = (
    <>
      <i aria-hidden="true" />
      <span className="session-label-full">{label}</span>
      <span className="session-label-short" aria-hidden="true">
        {checking ? "Checking" : active ? "Active" : "Inactive"}
      </span>
    </>
  );

  if (!active && !checking && onRequestSetup) {
    return (
      <button
        className={`session-indicator ${state} is-actionable`}
        onClick={onRequestSetup}
        type="button"
        aria-label="Session inactive — start session"
        title="Start a play session"
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={`session-indicator ${state}`}
      aria-label={label}
      title={label}
    >
      {content}
    </span>
  );
}
