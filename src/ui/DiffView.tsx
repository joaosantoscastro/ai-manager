"use client";

import { useMemo, useState } from "react";
import type { DiffResponse } from "./usePendingDiff";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./Spinner";

/** `/Users/me/.copilot/settings.json` → `~/.copilot/settings.json`. */
export function shortenPath(path: string): string {
  const match = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/);
  return match ? `~${match[1]}` : path;
}

/**
 * Splits a change description into an add/remove marker and its text, so
 * list edits read as a diff rather than as prose.
 */
function splitMarker(description: string): {
  marker: "+" | "-" | null;
  text: string;
} {
  const match = description.match(/^(.*?)\s([+-])\s(".*")$/);
  if (match) {
    return { marker: match[2] as "+" | "-", text: `${match[1]} ${match[3]}` };
  }
  return { marker: null, text: description };
}

export function DiffView({
  diff,
  busy,
  loading,
  onApply,
  onCancel,
  showHeader = true,
}: {
  diff: DiffResponse | null;
  busy?: boolean;
  /** True while the plan is being computed, so the list isn't claimed to be empty. */
  loading?: boolean;
  onApply?: () => void;
  onCancel?: () => void;
  /** Off when a surrounding dialog already titles the change list. */
  showHeader?: boolean;
}) {
  const [showStale, setShowStale] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, DiffResponse["changes"]>();
    for (const change of diff?.changes ?? []) {
      const list = map.get(change.file) ?? [];
      list.push(change);
      map.set(change.file, list);
    }
    return Array.from(map.entries());
  }, [diff]);

  const count = diff?.changes.length ?? 0;
  const stale = diff?.skipped ?? [];

  return (
    <div>
      {showHeader && (
        <header style={{ marginBottom: 18 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
            Review changes
          </h1>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            {count === 0
              ? loading
                ? "Working out what would be written…"
                : "Nothing is waiting to be written."
              : `${count} change${count === 1 ? "" : "s"} will be written to your Copilot configuration.`}
          </p>
        </header>
      )}

      {loading && count === 0 ? (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: 0,
            padding: "16px 0",
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          <Spinner size={14} label="Working out what would be written" />
          Working out what would be written…
        </p>
      ) : count === 0 ? (
        <EmptyState
          title="No pending changes"
          lines={[
            "Nothing you have changed is waiting to be written.",
            "Toggle something on any screen and it will show up here first.",
          ]}
        />
      ) : (
        groups.map(([file, changes]) => (
          <section key={file} style={{ marginBottom: 20 }}>
            <h2
              style={{
                fontSize: "var(--font-size-sm)",
                fontWeight: 600,
                margin: "0 0 6px",
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                wordBreak: "break-all",
              }}
            >
              {shortenPath(file)}
            </h2>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                overflow: "hidden",
              }}
            >
              {changes.map((change, i) => {
                const { marker, text } = splitMarker(change.description);
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 10,
                      padding: "8px 12px",
                      borderBottom:
                        i === changes.length - 1
                          ? "none"
                          : "1px solid var(--border)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 10,
                        flexShrink: 0,
                        fontWeight: 700,
                        color:
                          marker === "+"
                            ? "var(--success)"
                            : marker === "-"
                              ? "var(--danger)"
                              : "var(--text-muted)",
                      }}
                    >
                      {marker ?? "~"}
                    </span>
                    <span style={{ wordBreak: "break-word" }}>{text}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {stale.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <button
            type="button"
            onClick={() => setShowStale((v) => !v)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {showStale ? "▾" : "▸"} {stale.length} change
            {stale.length === 1 ? "" : "s"} could not be applied
          </button>
          {showStale && (
            <div
              style={{
                marginTop: 8,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                padding: "10px 12px",
                background: "var(--surface-subtle)",
              }}
            >
              <p
                style={{
                  margin: "0 0 8px",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--text-secondary)",
                }}
              >
                Copilot offers no way to write these. They are ignored and harm
                nothing.
              </p>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                {stale.map((s) => (
                  <li
                    key={s.nodeKey}
                    style={{ padding: "3px 0", wordBreak: "break-word" }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {s.nodeKey}
                    </span>
                    {" — "}
                    {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {(onApply || onCancel) && (
        <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          {onApply && (
            <Button
              variant="primary"
              onClick={onApply}
              disabled={busy || count === 0}
              minWidth={132}
            >
              {busy ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Spinner size={13} label="Applying" />
                  Applying…
                </span>
              ) : (
                "Apply changes"
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
