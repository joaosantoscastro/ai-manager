/**
 * Busy indicator. A ring with one coloured quarter, rotated by CSS.
 *
 * The animation lives in `globals.css` rather than here so that the
 * `prefers-reduced-motion` block can switch it off with every other
 * animation in the app. With motion reduced the ring simply stops turning —
 * it stays on screen, and `role="status"` still announces the wait, so the
 * meaning survives without the movement.
 */
export function Spinner({
  size = 16,
  label = "Loading",
}: {
  size?: number;
  label?: string;
}) {
  const thickness = Math.max(2, Math.round(size / 8));
  return (
    <span
      className="spinner"
      role="status"
      aria-label={label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        boxSizing: "border-box",
        border: `${thickness}px solid var(--border)`,
        borderTopColor: "var(--text-secondary)",
        borderRadius: "50%",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * The whole-panel waiting state, replacing what used to be a bare
 * `Loading…` paragraph. One component so every list and detail page waits
 * in the same way.
 */
export function LoadingLine({ text = "Loading…" }: { text?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: "var(--text-secondary)",
        fontSize: 13,
      }}
    >
      <Spinner size={14} label={text} />
      <span>{text}</span>
    </div>
  );
}
