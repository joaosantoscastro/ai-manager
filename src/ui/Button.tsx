"use client";

type Variant = "primary" | "secondary" | "ghost";

const STYLES: Record<Variant, React.CSSProperties> = {
  primary: {
    background: "var(--primary)",
    border: "1px solid var(--primary)",
    color: "#fff",
    fontWeight: 600,
  },
  secondary: {
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
    fontWeight: 500,
  },
  ghost: {
    background: "transparent",
    border: "1px solid transparent",
    color: "var(--text-secondary)",
    fontWeight: 500,
  },
};

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  title,
  type = "button",
  size = "md",
  ariaLabel,
  minWidth,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: Variant;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  size?: "sm" | "md" | "iconOnly";
  /** Required when the button renders only an icon, which has no text label. */
  ariaLabel?: string;
  /**
   * Reserves a fixed width. Use when the label changes between states, so the
   * button cannot resize and shift its neighbours under a moving cursor.
   */
  minWidth?: number;
}) {
  const square = size === "iconOnly";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={{
        ...STYLES[variant],
        height: size === "sm" ? 28 : "var(--control-height)",
        width: square ? "var(--control-height)" : undefined,
        minWidth,
        padding: square ? 0 : size === "sm" ? "0 10px" : "0 13px",
        display: square ? "inline-flex" : undefined,
        alignItems: square ? "center" : undefined,
        justifyContent: square ? "center" : undefined,
        borderRadius: "var(--radius-sm)",
        fontSize: "var(--font-size-sm)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
