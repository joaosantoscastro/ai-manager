"use client";

import { useEffect, useRef } from "react";

interface CheckboxProps {
  checked: boolean;
  /** Renders the dash state. Takes visual precedence over `checked`. */
  indeterminate?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

/**
 * 18px checkbox with a real indeterminate state, used for the MCP tools
 * allowlist where a server can have only some of its tools enabled.
 * `indeterminate` is a DOM property, not an attribute, so it has to be set
 * imperatively on the node.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled,
  title,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => onChange?.(e.target.checked)}
      style={{
        width: "var(--checkbox-size)",
        height: "var(--checkbox-size)",
        margin: 0,
        accentColor: "var(--primary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
      }}
    />
  );
}
