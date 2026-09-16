/**
 * Shared helpers for the `/api/tools` and `/api/mcp-oauth/*` routes: both
 * need to resolve which `McpServerConfig` to actually talk to for a given
 * discovered node, and the OAuth routes need it too so a sign-in flow
 * starts against the same real upstream config the tool loader itself
 * uses.
 */
import { nodeKey } from "./types";
import type { McpServerConfig } from "./tool-loader";
import type { ResolvedNode } from "./types";

/**
 * Resolves the config to talk to for one server.
 *
 * Once a server has been routed through the proxy, its declaration on disk
 * launches the proxy, and the proxy only answers `tools/list` with the
 * tools it allows. Reading that would report the filtered set as if it
 * were the server's whole inventory, and the disabled tools would vanish
 * from the UI. The stashed original is the only config that still reaches
 * the real upstream server, so use that instead.
 */
export function configFor(
  node: Pick<ResolvedNode, "id" | "raw">,
  proxiedServers: Record<string, unknown>,
): McpServerConfig | null {
  const stashedOriginal = proxiedServers[nodeKey(node.id)];
  const raw = (stashedOriginal ?? node.raw) as
    (Partial<McpServerConfig> & { type?: string }) | undefined;
  return raw?.type ? (raw as McpServerConfig) : null;
}

/** Runs `worker` over `items`, never more than `limit` at the same time. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
