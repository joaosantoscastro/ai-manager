import { Button } from "./Button";

/**
 * Empty states always explain *why* the list is empty and offer the next
 * action. A bare "Nothing here." is never acceptable — see design.md 15.
 */
export function EmptyState({
  title,
  lines,
  actionLabel,
  onAction,
}: {
  title: string;
  lines: string[];
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "40px 24px",
        textAlign: "center",
        background: "var(--surface)",
      }}
    >
      <p
        style={{ margin: 0, fontSize: "var(--font-size-md)", fontWeight: 600 }}
      >
        {title}
      </p>
      {lines.map((line) => (
        <p
          key={line}
          style={{
            margin: "4px 0 0",
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {line}
        </p>
      ))}
      {actionLabel && onAction && (
        <div style={{ marginTop: 16 }}>
          <Button onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Muted informational banner used where Copilot itself offers no control —
 * agents and hooks. Must read as intentionally unavailable, not broken, so
 * it uses neutral greys rather than an error colour.
 */
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "10px 12px",
        border: "1px solid var(--border)",
        background: "var(--surface-subtle)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-secondary)",
        marginBottom: 16,
      }}
    >
      <span aria-hidden style={{ lineHeight: 1.4 }}>
        &#9888;
      </span>
      <div>{children}</div>
    </div>
  );
}
