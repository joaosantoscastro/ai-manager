"use client";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * The `Scope ▾` / `Status ▾` / `MCP ▾` dropdowns. A native `<select>` keeps
 * keyboard and screen-reader behaviour correct for free; only the chrome is
 * restyled to match the 34px control height.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        height: "var(--control-height)",
        padding: "0 28px 0 10px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border-strong)",
        background:
          "var(--surface) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\") no-repeat right 9px center",
        fontSize: "var(--font-size-sm)",
        color: value === "all" ? "var(--text-secondary)" : "var(--text)",
        appearance: "none",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
