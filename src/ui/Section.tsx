export function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h2
          style={{
            fontSize: "var(--font-size-md)",
            fontWeight: 600,
            margin: 0,
          }}
        >
          {title}
        </h2>
        {action}
      </div>
      {subtitle && (
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
            margin: "3px 0 0",
          }}
        >
          {subtitle}
        </p>
      )}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/** Label/value pair used throughout the detail panels. */
export function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "7px 0",
        borderBottom: "1px solid var(--border)",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <span
        style={{
          flex: "0 0 150px",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          wordBreak: "break-word",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: mono ? 12.5 : undefined,
        }}
      >
        {children}
      </span>
    </div>
  );
}
