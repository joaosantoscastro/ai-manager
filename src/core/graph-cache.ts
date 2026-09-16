/**
 * Process-lifetime cache for the discovered SourceGraph. Discovery shells
 * out to the `copilot` CLI several times and walks the filesystem, so it's
 * not free — but it also isn't something we want stale forever if the user
 * enables a plugin from a separate terminal. `GET /api/graph` serves the
 * cache; `POST /api/graph/refresh` (or the "Refresh" button in the UI)
 * forces a re-discovery.
 */
import { discoverSourceGraph } from "@/adapters/copilot";
import type { SourceGraph } from "@/core/types";

let cached: { graph: SourceGraph; at: number } | null = null;
const TTL_MS = 30_000;

export async function getSourceGraph(opts?: {
  force?: boolean;
}): Promise<SourceGraph> {
  const now = Date.now();
  if (!opts?.force && cached && now - cached.at < TTL_MS) {
    return cached.graph;
  }
  const graph = await discoverSourceGraph();
  cached = { graph, at: now };
  return graph;
}

export function invalidateSourceGraphCache(): void {
  cached = null;
}
