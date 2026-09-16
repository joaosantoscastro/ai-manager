"use client";

import { useMemo } from "react";
import type { Kind, NodeId, Scope } from "@/core/types";
import { useSetupState } from "./SetupState";

interface UseGraphOptions {
  kind?: Kind | Kind[] | string | string[];
  scope?: Scope | Scope[] | string | string[];
}

function toSet(value?: string | string[]): Set<string> | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.length > 0 ? new Set(list) : undefined;
}

/**
 * A view onto the shared setup state, narrowed to the kinds/scopes a screen
 * cares about.
 *
 * This used to be a fetch-per-screen hook. It is now a pure selector: the
 * graph is loaded once by `SetupStateProvider`, and filtering happens here
 * in memory. Filtering must stay client-side because resolving a node needs
 * its parent — asking the server for only `kind=tool` would strip the MCP
 * server each tool hangs off and break the disabled-by-parent cascade.
 *
 * `toggle` records intent in memory and returns nothing to await. Nothing is
 * written until the user applies.
 */
export function useGraph(options: UseGraphOptions = {}) {
  const {
    nodes,
    status,
    error,
    warnings,
    generatedAt,
    refreshing,
    setEnabled,
    refreshDiscovery,
    reload,
  } = useSetupState();

  const kinds = toSet(options.kind as string | string[] | undefined);
  const scopes = toSet(options.scope as string | string[] | undefined);
  const kindsKey = kinds ? Array.from(kinds).sort().join(",") : "";
  const scopesKey = scopes ? Array.from(scopes).sort().join(",") : "";

  const filtered = useMemo(() => {
    let list = nodes;
    if (kindsKey) {
      const set = new Set(kindsKey.split(","));
      list = list.filter((n) => set.has(n.id.kind));
    }
    if (scopesKey) {
      const set = new Set(scopesKey.split(","));
      list = list.filter((n) => set.has(n.id.scope));
    }
    return list;
    // `nodes` is the only real dependency; the string keys make the filter
    // sets comparable by value so a fresh array literal in a caller's props
    // does not re-run this on every render.
  }, [nodes, kindsKey, scopesKey]);

  const data = useMemo(
    () =>
      status === "loading" && generatedAt === null
        ? null
        : { nodes: filtered, generatedAt: generatedAt ?? "", warnings },
    [status, generatedAt, filtered, warnings],
  );

  return {
    data,
    /** Only true before the first graph has arrived, so a re-fetch never blanks the screen. */
    loading: status === "loading" && generatedAt === null,
    refreshing,
    error: status === "error" ? error : null,
    reload,
    toggle: (nodeId: NodeId, enabled: boolean) => setEnabled(nodeId, enabled),
    refresh: refreshDiscovery,
  };
}
