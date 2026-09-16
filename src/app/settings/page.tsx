"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/ui/PageHeader";
import { Section, Field } from "@/ui/Section";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import { usePendingDiff } from "@/ui/usePendingDiff";
import { useSetupState } from "@/ui/SetupState";

interface SnapshotEntry {
  id: string;
  createdAt: string;
  note?: string;
  files: { path: string; existed: boolean }[];
}

/** How many snapshots the section itself shows. The rest live behind "View all". */
const VISIBLE_SNAPSHOTS = 4;

/**
 * The snapshot rows. Rendered twice — inline in the section, and again
 * inside the "View all" dialog — so both lists stay identical and reverting
 * works the same from either place.
 */
function SnapshotList({
  snapshots,
  reverting,
  onRevert,
}: {
  snapshots: SnapshotEntry[];
  reverting: string | null;
  onRevert: (id: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      {snapshots.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "11px 14px",
            borderBottom:
              i === snapshots.length - 1 ? "none" : "1px solid var(--border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: "var(--font-size-sm)",
                fontWeight: 500,
                fontFamily: "var(--font-mono)",
              }}
            >
              {s.id}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 2,
              }}
            >
              {s.note ?? "snapshot"} · {s.files.length} file
              {s.files.length === 1 ? "" : "s"}
            </div>
          </div>
          <Button
            size="sm"
            disabled={reverting !== null}
            onClick={() => onRevert(s.id)}
          >
            {reverting === s.id ? "Reverting…" : "Revert"}
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const { diff, pendingCount, busy, message, apply } = usePendingDiff();
  const { refreshDiscovery } = useSetupState();
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [reverting, setReverting] = useState<string | null>(null);
  const [revertMessage, setRevertMessage] = useState<string | null>(null);
  const [showingAll, setShowingAll] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/revert", { cache: "no-store" });
      const body = await res.json();
      setSnapshots(body.snapshots ?? []);
    } catch {
      setSnapshots([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    loadSnapshots();
  }, [loadSnapshots]);

  async function handleRevert(snapshotId: string) {
    setReverting(snapshotId);
    setRevertMessage(null);
    try {
      const res = await fetch("/api/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Revert failed");
      setRevertMessage(`Reverted to snapshot ${snapshotId}.`);
      // A revert rewrote the real config, so the discovered graph is stale.
      await Promise.all([loadSnapshots(), refreshDiscovery()]);
    } catch (err) {
      setRevertMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setReverting(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Apply your changes to the real Copilot configuration, or roll them back."
      />

      <Section
        title="Pending changes"
        subtitle={
          pendingCount > 0
            ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} are ready to write.`
            : "Nothing is waiting. Everything you see matches what is on disk."
        }
        action={
          pendingCount > 0 ? (
            <Link href="/settings/diff">
              <Button size="sm">Review diff</Button>
            </Link>
          ) : undefined
        }
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button
            variant="primary"
            disabled={busy || pendingCount === 0}
            onClick={() => {
              void apply();
            }}
          >
            {busy ? "Applying…" : "Apply changes"}
          </Button>
          {message && (
            <span
              style={{
                fontSize: "var(--font-size-sm)",
                color: "var(--text-secondary)",
              }}
            >
              {message}
            </span>
          )}
        </div>
        {diff &&
          (diff.settingsChanged ||
            diff.mcpConfigChanged ||
            (diff.hookFiles?.length ?? 0) > 0) && (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              Files affected:{" "}
              {[
                diff.settingsChanged && "settings.json",
                diff.mcpConfigChanged && "mcp-config.json",
                ...(diff.hookFiles ?? []),
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
      </Section>

      <Section
        title="Snapshots"
        subtitle="Every apply snapshots the files it is about to touch, so you can always go back."
      >
        {snapshots.length === 0 ? (
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
              margin: 0,
            }}
          >
            No snapshots yet. One is created the first time you apply.
          </p>
        ) : (
          <>
            <SnapshotList
              snapshots={snapshots.slice(0, VISIBLE_SNAPSHOTS)}
              reverting={reverting}
              onRevert={(id) => {
                void handleRevert(id);
              }}
            />
            {snapshots.length > VISIBLE_SNAPSHOTS && (
              <div style={{ marginTop: 10 }}>
                <Button size="sm" onClick={() => setShowingAll(true)}>
                  View all ({snapshots.length})
                </Button>
              </div>
            )}
          </>
        )}
        {revertMessage && (
          <p
            style={{
              marginTop: 12,
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            {revertMessage}
          </p>
        )}
      </Section>

      <Modal
        open={showingAll}
        onClose={() => setShowingAll(false)}
        title="All snapshots"
        description={`${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}, most recent first. Reverting rewrites the files that snapshot covers.`}
        width={620}
        footer={
          <Button onClick={() => setShowingAll(false)} disabled={busy}>
            Close
          </Button>
        }
      >
        <SnapshotList
          snapshots={snapshots}
          reverting={reverting}
          onRevert={(id) => {
            void handleRevert(id);
          }}
        />
      </Modal>

      <Section
        title="Where things live"
        subtitle="Your changes never touch the original configuration until you apply them."
      >
        <Field label="Source config" mono>
          ~/.copilot
        </Field>
        <Field label="Tool cache" mono>
          ~/.ai-setup-manager/managed-state.json
        </Field>
        <Field label="Snapshots" mono>
          ~/.ai-setup-manager/snapshots/
        </Field>
      </Section>
    </div>
  );
}
