"use client";

export function SearchBar({
  value,
  onChange,
  placeholder = "Search…",
  grow = true,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  grow?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        flex: grow ? "1 1 280px" : "0 0 auto",
        maxWidth: grow ? 380 : undefined,
        minWidth: 200,
      }}
    >
      <svg
        aria-hidden
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="2"
        strokeLinecap="round"
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
        }}
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          width: "100%",
          height: "var(--control-height)",
          padding: "0 10px 0 31px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border-strong)",
          fontSize: "var(--font-size-md)",
          background: "var(--surface)",
          color: "var(--text)",
        }}
      />
    </div>
  );
}
