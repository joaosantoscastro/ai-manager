/** Page title + one-line explanation, e.g. "Plugins" / "Install and manage Copilot plugins." */
export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header style={{ marginBottom: 18 }}>
      <h1
        style={{
          fontSize: 20,
          fontWeight: 600,
          margin: 0,
          letterSpacing: -0.2,
        }}
      >
        {title}
      </h1>
      {subtitle && (
        <p
          style={{
            margin: "3px 0 0",
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {subtitle}
        </p>
      )}
    </header>
  );
}

/** The search + filters line that sits between the page header and the list. */
export function ControlsRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

/** Small heading above a list card, e.g. "Configured" + count. */
export function ListHeading({
  label,
  count,
  action,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        margin: "0 0 8px",
      }}
    >
      <h2
        style={{ fontSize: "var(--font-size-md)", fontWeight: 600, margin: 0 }}
      >
        {label}
        {count !== undefined && (
          <span
            style={{
              marginLeft: 6,
              color: "var(--text-muted)",
              fontWeight: 400,
            }}
          >
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}
