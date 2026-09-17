"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  NodeId,
  OverrideMap,
  ResolvedNode,
  ToolLoadResult,
} from "@/core/types";
import { nodeKey } from "@/core/types";
import { resolveNodes } from "@/core/graph";
import type { PendingUpload } from "@/core/uploads";

/**
 * The single source of truth for everything the app has discovered and
 * everything the user has changed but not yet applied.
 *
 * Two rules define it:
 *
 *  1. **The graph is fetched once, for the whole app.** Every screen reads
 *     the same array. Pages used to fetch their own filtered copy of a
 *     ~230 kB payload, which meant navigating or re-rendering re-fetched it.
 *
 *  2. **A click is a state change, never a request.** Pending enable/disable
 *     decisions live here in memory until the user applies or cancels them.
 *     The only calls that leave the browser are: the initial graph load, an
 *     explicit refresh, reading a server's tools, reading the diff when the
 *     apply dialog opens, and the apply itself.
 *
 * Effective state is recomputed locally through the same `resolveNodes` the
 * server uses, so the parent cascade (a tool under a disabled server, a
 * server under a disabled plugin) updates on the very same render as the
 * control that was clicked — in every direction, without a round trip.
 *
 * Pending changes are deliberately not persisted. Reloading the page
 * discards them, which keeps "what you see" and "what is on disk" from
 * drifting apart across tabs.
 */

interface GraphResponse {
  nodes: ResolvedNode[];
  generatedAt: string;
  warnings: string[];
}

export type SetupStatus = "loading" | "ready" | "error";

export interface SetupStateValue {
  /** Every discovered node, resolved against the current pending changes. */
  nodes: ResolvedNode[];
  status: SetupStatus;
  error: string | null;
  warnings: string[];
  generatedAt: string | null;
  /** True while a refresh is in flight over already-rendered data. */
  refreshing: boolean;

  pendingCount: number;
  /** The pending set in the shape `/api/diff` and `/api/apply` expect. */
  pendingOverrides: OverrideMap;
  /**
   * Files waiting to be added, the second half of the pending set.
   *
   * Uploads cannot be expressed as an override — an override says "this
   * existing node should be off", while an upload brings something that does
   * not exist yet — so they travel alongside rather than inside
   * `pendingOverrides`. Both are resolved by the same Apply.
   */
  pendingUploads: PendingUpload[];
  hasPending: boolean;

  setEnabled: (id: NodeId, enabled: boolean) => void;
  setManyEnabled: (entries: { id: NodeId; enabled: boolean }[]) => void;
  addUploads: (uploads: PendingUpload[]) => void;
  removeUpload: (id: string) => void;
  clearPending: () => void;

  /** Re-reads the graph. Cheap: served from the discovery TTL cache. */
  reload: () => Promise<void>;
  /**
   * Forces a full re-discovery, bypassing the cache. Pending decisions are
   * kept where the node still exists and the decision still differs from
   * what was found on disk.
   */
  refreshDiscovery: () => Promise<void>;
  /** Called after a successful apply: pending is now on disk, so re-read. */
  afterApply: () => Promise<void>;

  /**
   * The cached `tools/list` result for an MCP server.
   *
   * `undefined` means it has not been looked up yet, `null` means it was
   * looked up and the server's tools have never been read.
   */
  toolsFor: (serverKey: string) => ToolLoadResult | null | undefined;
  /** Reads a server's cached inventory once per session. Repeat calls are free. */
  loadCachedTools: (serverKey: string) => void;
  /** Stores a freshly read inventory, so every view sees it at once. */
  recordTools: (serverKey: string, result: ToolLoadResult) => void;
  /**
   * Contacts every MCP server whose tools are not cached yet, so the whole
   * setup fills itself in without the user asking server by server. Runs
   * once per session; `force` re-reads every server regardless of cache.
   */
  loadAllTools: (force?: boolean) => Promise<void>;
  /** True while servers are being contacted in the background. */
  loadingTools: boolean;
}

const SetupStateContext = createContext<SetupStateValue | null>(null);

/**
 * Re-points the pending set at a freshly discovered graph.
 *
 * Discovery can happen while decisions are waiting: the user refreshes, or
 * an apply re-reads the setup. Decisions are keyed by node key, which is
 * stable across discoveries, so anything still present survives. Two kinds
 * are dropped. Decisions about nodes that no longer exist, and decisions
 * the new source state already satisfies. An apply puts every decision in
 * that second group, which is why the pending count empties itself.
 */
function reanchorPending(
  pending: Record<string, boolean>,
  nodes: ResolvedNode[],
): Record<string, boolean> {
  const sourceEnabled = new Map<string, boolean>();
  for (const node of nodes) {
    sourceEnabled.set(nodeKey(node.id), node.sourceEnabled);
  }

  const next: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(pending)) {
    const current = sourceEnabled.get(key);
    if (current !== undefined && current !== enabled) next[key] = enabled;
  }
  return next;
}

export function SetupStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [source, setSource] = useState<GraphResponse | null>(null);
  const [status, setStatus] = useState<SetupStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // Held as raw bytes in memory, never written anywhere until Apply. Like
  // every other pending change, a reload throws them away.
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  // Cached `tools/list` results, keyed by MCP server node key. Reading one
  // is a disk read on the server, so it is done once per session and shared
  // rather than repeated every time a tools tab mounts.
  const [tools, setTools] = useState<Record<string, ToolLoadResult | null>>({});
  const [loadingTools, setLoadingTools] = useState(false);
  const toolRequests = useRef(new Set<string>());
  // Latches before the request starts, so two pages mounting in the same
  // tick cannot both trigger a full sweep of every server.
  const loadedAll = useRef(false);

  // Refreshes can overlap (a manual refresh during an apply, say), so only
  // the newest response is allowed to set state.
  const requestSeq = useRef(0);

  const fetchGraph = useCallback(async (force: boolean) => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    setError(null);
    try {
      if (force) await fetch("/api/graph/refresh", { method: "POST" });
      const res = await fetch("/api/graph", { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json: GraphResponse = await res.json();
      if (seq !== requestSeq.current) return;
      setSource(json);
      setStatus("ready");
      setPending((current) =>
        Object.keys(current).length === 0
          ? current
          : reanchorPending(current, json.nodes),
      );
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      if (seq === requestSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    void fetchGraph(false);
  }, [fetchGraph]);

  const sourceNodes = useMemo(() => source?.nodes ?? [], [source]);

  const sourceEnabledByKey = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const node of sourceNodes)
      map.set(nodeKey(node.id), node.sourceEnabled);
    return map;
  }, [sourceNodes]);

  const pendingOverrides = useMemo<OverrideMap>(() => {
    const map: OverrideMap = {};
    for (const [key, enabled] of Object.entries(pending)) {
      map[key] = { enabled };
    }
    return map;
  }, [pending]);

  const nodes = useMemo(
    () => resolveNodes(sourceNodes, pendingOverrides).nodes,
    [sourceNodes, pendingOverrides],
  );

  /**
   * Records decisions, dropping any that merely restate what is already on
   * disk. An override equal to the source value is not a change: keeping one
   * would badge the node as modified and inflate the pending count with
   * something apply cannot resolve. This mirrors the identical rule in
   * `core/graph.ts` and `core/emit.ts`.
   */
  const applyDecisions = useCallback(
    (entries: { id: NodeId; enabled: boolean }[]) => {
      setPending((current) => {
        const next = { ...current };
        let changed = false;
        for (const { id, enabled } of entries) {
          const key = nodeKey(id);
          const sourceEnabled = sourceEnabledByKey.get(key);
          if (sourceEnabled === enabled) {
            if (key in next) {
              delete next[key];
              changed = true;
            }
          } else if (next[key] !== enabled) {
            next[key] = enabled;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    },
    [sourceEnabledByKey],
  );

  const setEnabled = useCallback(
    (id: NodeId, enabled: boolean) => applyDecisions([{ id, enabled }]),
    [applyDecisions],
  );

  const addUploads = useCallback((next: PendingUpload[]) => {
    // Replacing by id keeps a second drop of the same item from queuing it
    // twice, and lets the modal correct an entry it already added.
    setUploads((current) => {
      const incoming = new Set(next.map((u) => u.id));
      return [...current.filter((u) => !incoming.has(u.id)), ...next];
    });
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((current) => current.filter((upload) => upload.id !== id));
  }, []);

  const clearPending = useCallback(() => {
    setPending({});
    setUploads([]);
  }, []);

  const reload = useCallback(() => fetchGraph(false), [fetchGraph]);

  /**
   * Forces a full re-discovery. Pending decisions are kept wherever they
   * still make sense, so refreshing is safe to offer anywhere. It is not a
   * destructive action the user has to be warned about.
   */
  const refreshDiscovery = useCallback(() => fetchGraph(true), [fetchGraph]);

  const toolsFor = useCallback(
    (serverKey: string) => tools[serverKey],
    [tools],
  );

  const recordTools = useCallback(
    (serverKey: string, result: ToolLoadResult) => {
      toolRequests.current.add(serverKey);
      setTools((current) => ({ ...current, [serverKey]: result }));
    },
    [],
  );

  const loadCachedTools = useCallback((serverKey: string) => {
    // The ref latches before the request starts, so two tabs mounting in
    // the same tick cannot both ask for the same server.
    if (toolRequests.current.has(serverKey)) return;
    toolRequests.current.add(serverKey);

    void (async () => {
      let result: ToolLoadResult | null = null;
      try {
        const res = await fetch(
          `/api/tools?key=${encodeURIComponent(serverKey)}`,
          { cache: "no-store" },
        );
        if (res.ok) result = (await res.json()) as ToolLoadResult;
      } catch {
        result = null;
      }
      setTools((current) => ({ ...current, [serverKey]: result }));
    })();
  }, []);

  /**
   * Fills in every server whose tools are still unknown, in one request.
   *
   * The server side caps how many servers it contacts at once and skips
   * anything already cached, so this is cheap on every run after the first.
   * Results are merged into the same map the per-server reads use, so a
   * detail page opened afterwards already has its answer.
   */
  const loadAllTools = useCallback(
    async (force = false) => {
      if (loadedAll.current && !force) return;
      loadedAll.current = true;
      setLoadingTools(true);
      try {
        const res = await fetch("/api/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(force ? { force: true } : {}),
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          results?: Record<string, ToolLoadResult>;
        };
        const results = body.results ?? {};
        for (const key of Object.keys(results)) toolRequests.current.add(key);
        if (Object.keys(results).length > 0) {
          setTools((current) => ({ ...current, ...results }));
          // Newly discovered tools are new graph nodes, so the graph the
          // rest of the app renders from is now out of date.
          await fetchGraph(false);
        }
      } catch {
        // A failed sweep is not worth interrupting the page for. Each
        // server still shows its own error when its tab is opened.
        loadedAll.current = false;
      } finally {
        setLoadingTools(false);
      }
    },
    [fetchGraph],
  );

  const afterApply = useCallback(async () => {
    setPending({});
    // Unlike overrides, an upload has no source state to re-anchor against:
    // once written it is simply part of the graph, so the queue is emptied
    // outright rather than filtered.
    setUploads([]);
    await fetchGraph(true);
  }, [fetchGraph]);

  const value = useMemo<SetupStateValue>(
    () => ({
      nodes,
      status,
      error,
      warnings: source?.warnings ?? [],
      generatedAt: source?.generatedAt ?? null,
      refreshing,
      pendingCount: Object.keys(pending).length + uploads.length,
      pendingOverrides,
      pendingUploads: uploads,
      hasPending: Object.keys(pending).length > 0 || uploads.length > 0,
      setEnabled,
      setManyEnabled: applyDecisions,
      addUploads,
      removeUpload,
      clearPending,
      reload,
      refreshDiscovery,
      afterApply,
      toolsFor,
      loadCachedTools,
      recordTools,
      loadAllTools,
      loadingTools,
    }),
    [
      nodes,
      status,
      error,
      source,
      refreshing,
      pending,
      pendingOverrides,
      uploads,
      setEnabled,
      applyDecisions,
      addUploads,
      removeUpload,
      clearPending,
      reload,
      refreshDiscovery,
      afterApply,
      toolsFor,
      loadCachedTools,
      recordTools,
      loadAllTools,
      loadingTools,
    ],
  );

  return (
    <SetupStateContext.Provider value={value}>
      {children}
    </SetupStateContext.Provider>
  );
}

export function useSetupState(): SetupStateValue {
  const value = useContext(SetupStateContext);
  if (!value) {
    throw new Error("useSetupState must be used inside <SetupStateProvider>.");
  }
  return value;
}
