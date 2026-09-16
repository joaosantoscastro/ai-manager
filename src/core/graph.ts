/**
 * Merges discovered source nodes (what's actually on disk / reported by the
 * CLI) with a set of overrides into resolved nodes — the shape the UI and
 * the `emit` layer both consume.
 *
 * This module is deliberately pure and dependency-free (types only), because
 * both sides of the app run it: the server merges the source graph with the
 * overrides posted to `/api/diff`, and the browser merges the same graph
 * with the user's in-memory pending edits on every click. Sharing one
 * implementation is the only way those two can't drift.
 *
 * The only non-trivial rule here: a node's effective state is never just
 * "its own override or its own source value" — it is also forced off when
 * its parent (the plugin that provides it, or the MCP server a tool
 * belongs to) is effectively off. A user can still see and flip the child's
 * own toggle; it simply won't take effect until the parent is re-enabled,
 * and the UI must say so (`effectiveReason: disabledByParent`).
 */
import type {
  EffectiveReason,
  ResolvedGraph,
  ResolvedNode,
  SourceGraph,
  SourceNode,
} from "./types";
import { nodeKey } from "./types";

/**
 * The override set, keyed by `nodeKey(id)`. Only `enabled` is required so
 * the browser's pending map (a plain `nodeKey -> boolean`) can be passed
 * straight in without inventing timestamps it doesn't have.
 */
export type OverrideMap = Record<string, { enabled: boolean }>;

/**
 * Resolves every node against `overrides`, applying the parent cascade.
 * Pure: same inputs always produce the same output, and nothing here reads
 * the filesystem, the network, or the clock.
 */
export function resolveNodes(
  source: SourceNode[],
  overrides: OverrideMap,
): { nodes: ResolvedNode[]; warnings: string[] } {
  const byKey = new Map<string, SourceNode>();
  for (const node of source) byKey.set(nodeKey(node.id), node);

  const memo = new Map<string, ResolvedNode>();
  const visiting = new Set<string>();
  const warnings: string[] = [];

  function resolve(key: string): ResolvedNode | undefined {
    if (memo.has(key)) return memo.get(key);
    const node = byKey.get(key);
    if (!node) return undefined;

    if (visiting.has(key)) {
      warnings.push(`Cycle detected resolving "${key}" — using source state.`);
      return {
        ...node,
        effectiveEnabled: node.sourceEnabled,
        overridden: false,
        effectiveReason: { type: "source" },
      };
    }
    visiting.add(key);

    const stored = overrides[key];
    // Same rule the UI and `planEmit` use: an override that restates the
    // source value is not an override. Honouring one here would badge the
    // node as modified when nothing about it has actually moved.
    const override =
      stored && stored.enabled !== node.sourceEnabled ? stored : undefined;
    const ownEnabled = override ? override.enabled : node.sourceEnabled;

    let effectiveEnabled = ownEnabled;
    let effectiveReason: EffectiveReason = override
      ? { type: "overridden" }
      : { type: "source" };

    const parentKey = node.providedBy ? nodeKey(node.providedBy) : undefined;
    if (parentKey) {
      const parent = resolve(parentKey);
      if (parent && !parent.effectiveEnabled) {
        effectiveEnabled = false;
        effectiveReason = { type: "disabledByParent", parentKey };
      }
    }

    const resolved: ResolvedNode = {
      ...node,
      effectiveEnabled,
      overridden: Boolean(override),
      effectiveReason,
    };
    visiting.delete(key);
    memo.set(key, resolved);
    return resolved;
  }

  const nodes: ResolvedNode[] = [];
  for (const node of source) {
    const resolved = resolve(nodeKey(node.id));
    if (resolved) nodes.push(resolved);
  }

  return { nodes, warnings };
}

/** `resolveNodes` lifted to whole-graph shape, preserving discovery warnings. */
export function mergeGraph(
  source: SourceGraph,
  overrides: OverrideMap,
): ResolvedGraph {
  const { nodes, warnings } = resolveNodes(source.nodes, overrides);
  return {
    nodes,
    generatedAt: source.generatedAt,
    warnings: [...source.warnings, ...warnings],
  };
}

/** Convenience: find a resolved node's children given the merged graph. */
export function childrenOf(
  graph: ResolvedGraph,
  parentKey: string,
): ResolvedNode[] {
  return graph.nodes.filter(
    (n) => n.providedBy && nodeKey(n.providedBy) === parentKey,
  );
}

export function findByKey(
  graph: ResolvedGraph,
  key: string,
): ResolvedNode | undefined {
  return graph.nodes.find((n) => nodeKey(n.id) === key);
}
