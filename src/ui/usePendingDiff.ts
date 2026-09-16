"use client";

import { useCallback, useRef, useState } from "react";
import { useSetupState } from "./SetupState";

export interface DiffChange {
  file: string;
  description: string;
}

export interface DiffSkip {
  nodeKey: string;
  reason: string;
}

export interface DiffResponse {
  changes: DiffChange[];
  skipped: DiffSkip[];
  settingsChanged: boolean;
  mcpConfigChanged: boolean;
  /** Absolute paths of hook files this apply would rewrite. */
  hookFiles?: string[];
}

/**
 * The pending-changes bar's behaviour: how many changes are waiting, what
 * exactly they would write, and the actions that resolve them.
 *
 * The count comes straight from the shared state service, so it updates on
 * the same render as the control the user clicked — no request. The full
 * diff needs `planEmit`, which reads the real config files, so it is fetched
 * explicitly: when the apply dialog opens, and on the standalone diff page.
 * That is the difference between one call per apply and one call per click.
 */
export function usePendingDiff() {
  const {
    pendingCount,
    pendingOverrides,
    hasPending,
    clearPending,
    afterApply,
  } = useSetupState();

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The dialog can be opened and closed faster than a plan completes, so
  // only the newest response is allowed to set state.
  const requestSeq = useRef(0);

  const loadDiff = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoadingDiff(true);
    try {
      const res = await fetch("/api/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: pendingOverrides }),
        cache: "no-store",
      });
      if (!res.ok) return;
      const body: DiffResponse = await res.json();
      if (seq === requestSeq.current) setDiff(body);
    } catch {
      // A failed diff read must never block the UI; the dialog just shows
      // nothing to preview and apply stays available.
    } finally {
      if (seq === requestSeq.current) setLoadingDiff(false);
    }
  }, [pendingOverrides]);

  const apply = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: pendingOverrides }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Apply failed");
      // No success banner: the diff clearing and the pending count dropping
      // to zero already say it worked, and the snapshot is always listed on
      // Settings if the user wants to revert.
      setDiff(null);
      // The changes are on disk now, so the pending set is empty and the
      // graph must be re-read to show the new source state.
      await afterApply();
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [pendingOverrides, afterApply]);

  /** Throws the pending set away. Nothing was ever written, so nothing to undo. */
  const discard = useCallback(() => {
    clearPending();
    setDiff(null);
    setMessage(null);
  }, [clearPending]);

  return {
    diff,
    pendingCount,
    hasPending,
    busy,
    loadingDiff,
    message,
    loadDiff,
    apply,
    discard,
  };
}
