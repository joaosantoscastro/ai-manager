"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "./Button";
import { DiffView } from "./DiffView";
import { Modal } from "./Modal";
import { RefreshIcon } from "./icons";
import { useSetupState } from "./SetupState";
import { usePendingDiff } from "./usePendingDiff";

/**
 * There is deliberately no top-level "Tools" entry. A tool only means
 * anything under the server that provides it, so tools are managed on each
 * MCP server's detail page rather than in a flat cross-server list.
 */
const TABS = [
  { href: "/plugins", label: "Plugins" },
  { href: "/mcp", label: "MCP" },
  { href: "/skills", label: "Skills" },
  { href: "/agents", label: "Agents" },
  { href: "/hooks", label: "Hooks" },
  { href: "/settings", label: "Settings" },
];

function SectionNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Sections"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        minWidth: 0,
        overflowX: "auto",
        scrollbarWidth: "none",
      }}
    >
      {TABS.map((tab) => {
        const active =
          pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: "var(--control-height)",
              padding: "0 11px",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--font-size-md)",
              fontWeight: active ? 600 : 400,
              color: active ? "var(--text)" : "var(--text-secondary)",
              background: active ? "var(--surface-subtle)" : "transparent",
              whiteSpace: "nowrap",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Fixed 54px application header: section navigation on the left, and the only
 * setup-wide actions on the right — refresh discovery, discard pending
 * changes, apply them.
 *
 * Both destructive actions go through a dialog rather than an inline confirm.
 * Apply writes real files under `~/.copilot` and discard throws away work that
 * cannot be recovered, so neither should be reachable by a single stray click
 * on a header that re-renders whenever managed state moves.
 *
 * There is deliberately no "+ Add" action: this tool manages the setup already
 * present on disk and has no install or marketplace capability to put behind
 * such a button.
 */
export function AppHeader() {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [reviewingApply, setReviewingApply] = useState(false);
  const { refreshing, refreshDiscovery } = useSetupState();
  const {
    diff,
    pendingCount,
    hasPending: hasChanges,
    busy,
    loadingDiff,
    message,
    loadDiff,
    apply,
    discard,
  } = usePendingDiff();

  function handleDiscard() {
    setConfirmingDiscard(false);
    discard();
  }

  function openApply() {
    setReviewingApply(true);
    // The only time the diff is read: it needs `planEmit` against the real
    // config files, which is far too expensive to run on every click.
    void loadDiff();
  }

  async function handleApply() {
    const ok = await apply();
    // Stay open on failure so the reason is read next to the changes it
    // refers to, rather than behind a dialog the user just dismissed.
    if (ok) setReviewingApply(false);
  }

  return (
    <header
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          maxWidth: "var(--content-width)",
          margin: "0 auto",
          height: "var(--header-height)",
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <SectionNav />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <Button
            size="iconOnly"
            ariaLabel="Refresh discovery"
            title="Refresh discovery"
            onClick={() => {
              void refreshDiscovery();
            }}
            disabled={refreshing}
          >
            <RefreshIcon />
          </Button>

          {hasChanges && (
            <Button onClick={() => setConfirmingDiscard(true)} disabled={busy}>
              Cancel
            </Button>
          )}

          <Button
            variant="primary"
            disabled={!hasChanges || busy}
            title={
              hasChanges ? undefined : "There are no pending changes to apply."
            }
            onClick={openApply}
          >
            {busy
              ? "Applying…"
              : hasChanges
                ? `Apply Changes (${pendingCount})`
                : "Apply Changes"}
          </Button>
        </div>
      </div>

      {message && (
        <div
          role="status"
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--surface-subtle)",
          }}
        >
          <div
            style={{
              maxWidth: "var(--content-width)",
              margin: "0 auto",
              padding: "8px 24px",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            {message}
          </div>
        </div>
      )}

      <Modal
        open={confirmingDiscard}
        onClose={() => setConfirmingDiscard(false)}
        title="Discard pending changes?"
        description={`${pendingCount} pending change${pendingCount === 1 ? "" : "s"} will be thrown away. Nothing on disk is touched either way, but this cannot be undone.`}
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmingDiscard(false)}>
              Keep changes
            </Button>
            <Button variant="primary" disabled={busy} onClick={handleDiscard}>
              Discard changes
            </Button>
          </>
        }
      />

      <Modal
        open={reviewingApply}
        onClose={() => setReviewingApply(false)}
        title="Apply changes"
        description={`${pendingCount} change${pendingCount === 1 ? "" : "s"} will be written to your Copilot configuration.`}
        width={620}
        footer={
          <>
            <Button onClick={() => setReviewingApply(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !hasChanges}
              onClick={() => {
                void handleApply();
              }}
            >
              {busy ? "Applying…" : "Confirm & apply"}
            </Button>
          </>
        }
      >
        <DiffView diff={diff} showHeader={false} loading={loadingDiff} />
      </Modal>
    </header>
  );
}
