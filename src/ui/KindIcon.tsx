import type { Kind } from "@/core/types";

/**
 * Per-kind glyph. Real product logos are deliberately not used: the setup
 * contains arbitrary local MCP servers and plugins, so there is no reliable
 * logo source and a partial set would look broken.
 */
function Glyph({ kind }: { kind: Kind }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (kind) {
    case "plugin":
      return (
        <svg {...common}>
          <path d="M9 2v6M15 2v6" />
          <path d="M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
          <path d="M12 18v4" />
        </svg>
      );
    case "mcp":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      );
    case "tool":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-2-2-2 2Z" />
        </svg>
      );
    case "skill":
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      );
    case "agent":
      return (
        <svg {...common}>
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M12 8V4M9 14h.01M15 14h.01M2 13v3M22 13v3" />
        </svg>
      );
    case "hook":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <path d="M6 8.5V14a4 4 0 0 0 4 4h5.5" />
        </svg>
      );
    case "command":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      );
    case "instruction":
    default:
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
  }
}

/** 40px tile. `size="sm"` (32px) is used inside dense tables. */
export function KindIcon({
  kind,
  size = 40,
  muted,
}: {
  kind: Kind;
  size?: number;
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-md)",
        background: "var(--surface-subtle)",
        border: "1px solid var(--border)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: muted ? "var(--text-muted)" : "var(--text-secondary)",
        flexShrink: 0,
      }}
    >
      <Glyph kind={kind} />
    </span>
  );
}
