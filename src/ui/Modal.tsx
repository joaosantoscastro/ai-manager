"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The application's only dialog. Deliberately plain: a solid panel on a dark
 * scrim, no blur and no translucency, so it reads as part of the same
 * administrative surface as everything behind it.
 *
 * Both callers guard an irreversible action, so the accessibility basics are
 * not optional here: focus moves in on open and returns to the trigger on
 * close, Tab is trapped, and Escape always offers a way out.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;

    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    // Defer so the panel exists before we reach into it for a focus target.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      target.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  // No mount flag needed: both callers start closed, so a server render
  // always short-circuits here long before it could reach for `document`.
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      onMouseDown={(event) => {
        // mousedown, not click: a drag that starts inside the panel and ends
        // on the scrim must not be read as a dismissal.
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(16, 20, 24, 0.55)",
        display: "flex",
        justifyContent: "center",
        padding: 24,
        overflowY: "auto",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: width,
          // Centred with `margin: auto`, not `align-items: center`. An auto
          // cross-axis margin also suppresses the default stretch, and unlike
          // centring it never pushes the top of a tall panel out of reach
          // above the scroll origin.
          margin: "auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "0 8px 28px rgba(16, 20, 24, 0.18)",
          outline: "none",
        }}
      >
        <div style={{ padding: "18px 20px 0" }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {title}
          </h2>
          {description && (
            <p
              id={descriptionId}
              style={{
                margin: "6px 0 0",
                fontSize: "var(--font-size-sm)",
                color: "var(--text-secondary)",
              }}
            >
              {description}
            </p>
          )}
        </div>

        {children && (
          <div
            style={{
              padding: "16px 20px 0",
              maxHeight: "50vh",
              overflowY: "auto",
            }}
          >
            {children}
          </div>
        )}

        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "18px 20px 18px",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
