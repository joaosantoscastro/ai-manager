"use client";

interface ToggleProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

/**
 * iOS-style 40x24 switch. Blue when on, neutral grey when off — blue is the
 * only accent colour in the UI and it only ever means "enabled".
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  title,
  "aria-label": ariaLabel,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={{
        width: 40,
        height: 24,
        borderRadius: 999,
        border: "1px solid transparent",
        background: checked ? "var(--primary)" : "#d8dce1",
        position: "relative",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: 0,
        flexShrink: 0,
        transition: "background 120ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 120ms ease",
        }}
      />
    </button>
  );
}
