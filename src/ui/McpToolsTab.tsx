"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedNode, ToolLoadResult } from "@/core/types";
import { nodeKey } from "@/core/types";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { SearchBar } from "./SearchBar";
import { EmptyState } from "./EmptyState";
import { RefreshIcon } from "./icons";
import { McpSignIn } from "./McpSignIn";
import { lockReason } from "./ResourceRow";
import { useSetupState } from "./SetupState";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

interface McpToolsTabProps {
  server: ResolvedNode;
  tools: ResolvedNode[];
  /** Records intent in the shared state service. Synchronous: nothing is written yet. */
  onToggle: (node: ResolvedNode, enabled: boolean) => void;
  /** Sets several tools at once, so "toggle all" is a single state update. */
  onToggleMany: (entries: { node: ResolvedNode; enabled: boolean }[]) => void;
  /**
   * Called after the server's real tool inventory changes, so the parent can
   * re-read the graph and this tab receives the newly discovered `tools` rows.
   */
  onInventoryChanged: () => void;
}

/**
 * The tools allowlist for one MCP server.
 *
 * The `tools[]` array in mcp-config.json is a *filter*, not an inventory —
 * a wildcard (`["*"]`) or absent `tools` key means "everything the server
 * has", not "nothing". The only way to know what that really is is to ask
 * the live server for `tools/list`. That happens on its own: this tab
 * fetches once when opened with nothing known, so a server like
 * `mcp-atlassian` (9 tools allowlisted out of 98 it actually provides)
 * shows all 98 rows rather than an empty table. The refresh button only
 * exists to re-read a server whose inventory has since changed.
 *
 * Every checkbox here writes to the shared state service and nothing else.
 * Clicking twenty tools costs zero requests; the change reaches disk only
 * when the user applies.
 *
 * Tools use checkboxes rather than toggles because they are a multi-select
 * set with a master row that can be indeterminate — a switch cannot
 * express "some".
 */
export function McpToolsTab({
  server,
  tools,
  onToggle,
  onToggleMany,
  onInventoryChanged,
}: McpToolsTabProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const { toolsFor, loadCachedTools, recordTools } = useSetupState();

  // A ref, not state: this must latch the moment the automatic read starts,
  // and survive every re-render in between, so a parent re-rendering
  // mid-request can never start a second one.
  const autoLoadedFor = useRef<string | null>(null);

  const serverKey = nodeKey(server.id);

  // `undefined` until the cached result has been read, then either the
  // result or `null` for "never read". The read itself is shared: the
  // state service does it once per server per session, so leaving and
  // re-entering this tab costs nothing.
  const cached = toolsFor(serverKey);
  const cacheChecked = cached !== undefined;
  const result = cached ?? null;

  useEffect(() => {
    loadCachedTools(serverKey);
  }, [loadCachedTools, serverKey]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: serverKey }),
      });
      const loaded: ToolLoadResult = await res.json();
      recordTools(serverKey, loaded);
      if (loaded.ok) onInventoryChanged();
    } catch (err) {
      recordTools(serverKey, {
        server: server.id.name,
        tools: [],
        at: new Date().toISOString(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [serverKey, server.id.name, onInventoryChanged, recordTools]);

  // The callback route runs in a popup, outside this component's tree
  // entirely, so it can only hand results back via `postMessage`. Once one
  // arrives naming this server, re-read its tools with the token now on
  // file — this is how a sign-in click turns back into a normal reload.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { source?: string; ok?: boolean; serverKey?: string }
        | undefined;
      if (!data || data.source !== "mcp-oauth") return;
      if (data.serverKey && data.serverKey !== serverKey) return;
      if (data.ok) void reload();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [serverKey, reload]);

  useEffect(() => {
    // Read the live inventory exactly once, and only when we've confirmed
    // there is no cached result yet AND the graph currently has zero tool
    // rows for this server (the signature of an unread wildcard/absent
    // tools declaration). A server with an explicit, non-wildcard tools[]
    // already has rows and never needs this.
    if (!cacheChecked || loading) return;
    if (autoLoadedFor.current === serverKey) return;
    if (result !== null || tools.length > 0) return;
    autoLoadedFor.current = serverKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the one-shot automatic read; the ref above latches it before it starts
    void reload();
  }, [cacheChecked, loading, result, tools.length, reload, serverKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? tools.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            (t.description?.toLowerCase().includes(q) ?? false),
        )
      : tools;
  }, [tools, query]);

  const serverLocked = !server.effectiveEnabled;
  const togglable = visible.filter((t) => lockReason(t) === null);
  const enabledCount = tools.filter((t) => t.effectiveEnabled).length;
  const allOn =
    togglable.length > 0 && togglable.every((t) => t.effectiveEnabled);
  const someOn = togglable.some((t) => t.effectiveEnabled);

  const discovered =
    tools.length > 0 &&
    Boolean((tools[0].raw as { discovered?: boolean } | undefined)?.discovered);

  function setAll(enabled: boolean) {
    // One state update for the whole set. This used to be a sequential loop
    // of writes, one HTTP round trip per tool, because each toggle
    // read-modify-wrote a file on disk and parallel calls would race.
    onToggleMany(
      togglable
        .filter((tool) => tool.effectiveEnabled !== enabled)
        .map((tool) => ({ node: tool, enabled })),
    );
  }

  const provenance = discovered
    ? `${tools.length} tool${tools.length === 1 ? "" : "s"} · read from the server ${result ? relativeTime(result.at) : ""}`
    : tools.length > 0
      ? `${tools.length} tool${tools.length === 1 ? "" : "s"} from configuration`
      : null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: "var(--font-size-md)", fontWeight: 600 }}>
            Tools
          </div>
          <div
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            {tools.length > 0
              ? `${provenance} · ${enabledCount} enabled`
              : loading
                ? "Reading…"
                : "0 tools known"}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Button
          size="iconOnly"
          ariaLabel="Refresh tools"
          title="Ask this server for its tools again"
          onClick={() => {
            void reload();
          }}
          disabled={loading}
        >
          <RefreshIcon />
        </Button>
      </div>

      {result && result.needsAuth && (
        <McpSignIn
          serverKey={serverKey}
          result={result}
          busy={loading}
          onSignedIn={() => {
            void reload();
          }}
        />
      )}

      {result && !result.ok && result.stale && !result.needsAuth && (
        <div
          role="status"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "10px 14px",
            marginBottom: 12,
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          Showing the last known tools — the most recent refresh failed
          {result.error ? `: ${result.error}` : "."}
        </div>
      )}

      {result && !result.ok && !result.stale && !result.needsAuth && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "12px 14px",
            marginBottom: 12,
          }}
        >
          <p
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: "var(--font-size-md)",
            }}
          >
            Tools unavailable
          </p>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            Could not read the tools from this MCP server.
          </p>
          <p
            style={{
              margin: "1px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            Check its environment variables or network access.
          </p>
          {result.error && (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                wordBreak: "break-word",
              }}
            >
              {result.error}
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <Button
              onClick={() => {
                void reload();
              }}
              disabled={loading}
              size="sm"
            >
              Try again
            </Button>
          </div>
        </div>
      )}

      {result && result.ok && result.error && (
        <div
          role="status"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "10px 14px",
            marginBottom: 12,
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {result.error}
        </div>
      )}

      {tools.length === 0 && !result?.needsAuth ? (
        <EmptyState
          title={loading ? "Reading tools…" : "No tools known yet"}
          lines={
            loading
              ? [
                  "Starting the server to ask what tools it provides.",
                  "This can take a few seconds.",
                ]
              : [
                  "This server has no explicit tools list, so it may expose everything it offers.",
                  "Refresh to read the real inventory from the server.",
                ]
          }
          actionLabel={loading ? undefined : "Refresh tools"}
          onAction={() => {
            void reload();
          }}
        />
      ) : tools.length === 0 ? null : (
        <>
          <div style={{ marginBottom: 10 }}>
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Search tools…"
            />
          </div>

          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 14px",
                background: "var(--surface-subtle)",
                borderBottom: "1px solid var(--border)",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              <Checkbox
                checked={allOn}
                indeterminate={!allOn && someOn}
                disabled={serverLocked || togglable.length === 0}
                aria-label="Toggle all tools"
                onChange={setAll}
              />
              <span style={{ flex: "1 1 30%", minWidth: 0 }}>Tool</span>
              <span style={{ flex: "1 1 60%", minWidth: 0 }}>Description</span>
            </div>

            {visible.map((tool, i) => {
              const locked = lockReason(tool);
              return (
                <label
                  key={tool.id.name}
                  className="row-hover"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    borderBottom:
                      i === visible.length - 1
                        ? "none"
                        : "1px solid var(--border)",
                    fontSize: "var(--font-size-sm)",
                    cursor: locked || serverLocked ? "default" : "pointer",
                  }}
                >
                  <Checkbox
                    checked={tool.effectiveEnabled}
                    disabled={serverLocked || locked !== null}
                    title={
                      serverLocked
                        ? "The server is disabled, so its tools cannot be changed."
                        : (locked ?? undefined)
                    }
                    aria-label={tool.displayName}
                    onChange={(next) => onToggle(tool, next)}
                  />
                  <span
                    style={{
                      flex: "1 1 30%",
                      minWidth: 0,
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: serverLocked ? "var(--text-muted)" : "var(--text)",
                      wordBreak: "break-word",
                    }}
                  >
                    {tool.displayName}
                  </span>
                  <span
                    style={{
                      flex: "1 1 60%",
                      minWidth: 0,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {tool.description ?? "—"}
                  </span>
                </label>
              );
            })}

            {visible.length === 0 && (
              <p
                style={{
                  margin: 0,
                  padding: "16px 14px",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--text-secondary)",
                }}
              >
                No tools match &ldquo;{query}&rdquo;.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
