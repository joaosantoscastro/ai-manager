"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type ToastTone = "success" | "error";

export interface ToastInput {
  tone: ToastTone;
  message: string;
}

interface ToastItem extends ToastInput {
  id: number;
}

/** Successes are disposable; failures carry a reason the user needs to read. */
const SUCCESS_DISMISS_MS = 6000;

const ToastContext = createContext<((input: ToastInput) => void) | null>(null);

/**
 * The application's transient result channel.
 *
 * Deliberately plain, like `Modal`: a solid panel with a small status dot,
 * no blur and no translucency, so a toast reads as the same administrative
 * surface as the page behind it.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setItems((current) => [...current, { ...input, id }]);
      if (input.tone === "success") {
        setTimeout(() => dismiss(id), SUCCESS_DISMISS_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 60,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: "min(380px, calc(100vw - 40px))",
          pointerEvents: "none",
        }}
      >
        {items.map((item) => (
          <ToastPanel
            key={item.id}
            item={item}
            onDismiss={() => dismiss(item.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastPanel({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  const accent = item.tone === "error" ? "var(--danger)" : "var(--success)";
  return (
    <div
      className="toast-enter"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 10px 10px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "0 4px 14px rgba(31, 35, 40, 0.12)",
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 8,
          height: 8,
          marginTop: 6,
          borderRadius: "50%",
          background: accent,
        }}
      />
      <p
        style={{
          margin: 0,
          flex: 1,
          minWidth: 0,
          fontSize: "var(--font-size-sm)",
          color: "var(--text)",
          wordBreak: "break-word",
        }}
      >
        {item.message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-muted)",
          fontSize: 15,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}

/** Raises a toast. Throws if used outside `ToastProvider`, which is a wiring bug. */
export function useToast(): (input: ToastInput) => void {
  const toast = useContext(ToastContext);
  if (!toast) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return toast;
}
