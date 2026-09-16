"use client";

import { useMemo, useState } from "react";
import type { Kind, ResolvedNode, Scope } from "@/core/types";
import { useGraph } from "./useGraph";
import { SearchBar } from "./SearchBar";
import { FilterSelect, type FilterOption } from "./FilterSelect";
import { PageHeader, ControlsRow, ListHeading } from "./PageHeader";
import { ResourceList } from "./ResourceList";
import { EmptyState, Notice } from "./EmptyState";

export type BuiltInFilter = "scope" | "status" | "mcp" | "hookEvent";

interface ResourceBrowserProps {
  kinds: Kind[];
  scopes?: Scope[];
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  /** Heading above the list card, e.g. "Installed" or "Configured". */
  listLabel: string;
  filters?: BuiltInFilter[];
  hrefFor?: (node: ResolvedNode) => string | undefined;
  metaFor?: (node: ResolvedNode) => string | undefined;
  /** Shown above the controls, for kinds Copilot gives us no control over. */
  notice?: React.ReactNode;
  /** Page-level action, pushed to the right of the controls row. */
  headerAction?: React.ReactNode;
  empty: { title: string; lines: string[] };
}

const SCOPE_OPTIONS: FilterOption[] = [
  { value: "all", label: "Scope: all" },
  { value: "user", label: "User" },
  { value: "plugin", label: "Plugin" },
  { value: "repository", label: "Repository" },
];

const STATUS_OPTIONS: FilterOption[] = [
  { value: "all", label: "Status: all" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

function matches(node: ResolvedNode, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    node.displayName.toLowerCase().includes(needle) ||
    node.id.name.toLowerCase().includes(needle) ||
    (node.description?.toLowerCase().includes(needle) ?? false)
  );
}

function serverOf(node: ResolvedNode): string | undefined {
  return node.controllable.type === "mcpToolFilter"
    ? node.controllable.server
    : undefined;
}

/**
 * The event a hook node fires on. Read from the node name (`event:command`)
 * rather than `raw`, so the browser stays free of adapter-shaped types.
 */
function hookEventOf(node: ResolvedNode): string | undefined {
  if (node.controllable.type !== "hookToggle") return undefined;
  const at = node.id.name.indexOf(":");
  return at === -1 ? undefined : node.id.name.slice(0, at);
}

/**
 * The engine behind every list screen: header, search, filters, one list
 * card. Filtering is client-side because the whole graph is small (tens of
 * nodes) and it keeps the fetch cacheable.
 */
export function ResourceBrowser({
  kinds,
  scopes,
  title,
  subtitle,
  searchPlaceholder,
  listLabel,
  filters = [],
  hrefFor,
  metaFor,
  notice,
  headerAction,
  empty,
}: ResourceBrowserProps) {
  const { data, loading, error, toggle, refresh } = useGraph({
    kind: kinds,
    scope: scopes,
  });
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [server, setServer] = useState("all");
  const [hookEvent, setHookEvent] = useState("all");

  const serverOptions = useMemo<FilterOption[]>(() => {
    const names = new Set<string>();
    for (const n of data?.nodes ?? []) {
      const s = serverOf(n);
      if (s) names.add(s);
    }
    return [
      { value: "all", label: "MCP: all" },
      ...Array.from(names)
        .sort()
        .map((n) => ({ value: n, label: n })),
    ];
  }, [data]);

  const hookEventOptions = useMemo<FilterOption[]>(() => {
    const events = new Set<string>();
    for (const n of data?.nodes ?? []) {
      const e = hookEventOf(n);
      if (e) events.add(e);
    }
    return [
      { value: "all", label: "Event: all" },
      ...Array.from(events)
        .sort()
        .map((e) => ({ value: e, label: e })),
    ];
  }, [data]);

  const visible = useMemo(() => {
    let list = data?.nodes ?? [];
    const q = query.trim();
    if (q) list = list.filter((n) => matches(n, q));
    if (scope !== "all") list = list.filter((n) => n.id.scope === scope);
    if (status !== "all") {
      const want = status === "enabled";
      list = list.filter((n) => n.effectiveEnabled === want);
    }
    if (server !== "all") list = list.filter((n) => serverOf(n) === server);
    if (hookEvent !== "all")
      list = list.filter((n) => hookEventOf(n) === hookEvent);
    return list;
  }, [data, query, scope, status, server, hookEvent]);

  const filtersActive =
    query.trim() !== "" ||
    scope !== "all" ||
    status !== "all" ||
    server !== "all" ||
    hookEvent !== "all";

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />

      {notice && <Notice>{notice}</Notice>}

      <ControlsRow>
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder}
        />
        {filters.includes("scope") && (
          <FilterSelect
            label="Scope"
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={setScope}
          />
        )}
        {filters.includes("mcp") && (
          <FilterSelect
            label="MCP server"
            value={server}
            options={serverOptions}
            onChange={setServer}
          />
        )}
        {filters.includes("hookEvent") && (
          <FilterSelect
            label="Event"
            value={hookEvent}
            options={hookEventOptions}
            onChange={setHookEvent}
          />
        )}
        {filters.includes("status") && (
          <FilterSelect
            label="Status"
            value={status}
            options={STATUS_OPTIONS}
            onChange={setStatus}
          />
        )}
        {headerAction && (
          <div style={{ marginLeft: "auto" }}>{headerAction}</div>
        )}
      </ControlsRow>

      {loading && (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>
      )}

      {error && (
        <EmptyState
          title="Could not read the local setup"
          lines={[error, "Check that the app can read your Copilot directory."]}
          actionLabel="Retry"
          onAction={() => refresh()}
        />
      )}

      {!loading && !error && visible.length === 0 && (
        <EmptyState
          title={filtersActive ? "No matches" : empty.title}
          lines={
            filtersActive
              ? ["No items match your search and filters in this view."]
              : empty.lines
          }
          actionLabel={filtersActive ? undefined : "Refresh discovery"}
          onAction={filtersActive ? undefined : () => refresh()}
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <>
          <ListHeading label={listLabel} count={visible.length} />
          <ResourceList
            nodes={visible}
            hrefFor={hrefFor}
            metaFor={metaFor}
            onToggle={(node, enabled) => toggle(node.id, enabled)}
          />
        </>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <p
          style={{
            marginTop: 14,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          {data.warnings.join(" · ")}
        </p>
      )}
    </div>
  );
}
