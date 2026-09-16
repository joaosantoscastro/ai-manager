type BadgeTone = "neutral" | "info" | "muted";

const TONE: Record<BadgeTone, { color: string; border: string; bg: string }> = {
  neutral: {
    color: "var(--text-secondary)",
    border: "var(--border-strong)",
    bg: "transparent",
  },
  info: {
    color: "var(--primary)",
    border: "var(--primary)",
    bg: "transparent",
  },
  muted: {
    color: "var(--text-muted)",
    border: "var(--border)",
    bg: "var(--surface-subtle)",
  },
};

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${t.border}`,
        background: t.bg,
        fontSize: 12,
        lineHeight: "17px",
        fontWeight: 500,
        color: t.color,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
