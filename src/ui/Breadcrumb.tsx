import Link from "next/link";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * `‹ MCP › github` — the trailing crumb is the current page and is not a link.
 *
 * `action` sits on the same line, pushed right. It stays outside the `nav`
 * so a button never reads as part of the breadcrumb trail.
 */
export function Breadcrumb({
  items,
  action,
}: {
  items: Crumb[];
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 14,
        minHeight: action ? "var(--control-height)" : undefined,
      }}
    >
      <nav
        aria-label="Breadcrumb"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          fontSize: "var(--font-size-sm)",
        }}
      >
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <span
              key={`${item.label}-${i}`}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              {i > 0 && (
                <span aria-hidden style={{ color: "var(--text-muted)" }}>
                  &rsaquo;
                </span>
              )}
              {item.href && !last ? (
                <Link
                  href={item.href}
                  style={{ color: "var(--primary)", fontWeight: 500 }}
                >
                  {i === 0 && <span aria-hidden>&lsaquo; </span>}
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  style={{
                    color: last ? "var(--text)" : "var(--text-secondary)",
                  }}
                >
                  {item.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      {action}
    </div>
  );
}
