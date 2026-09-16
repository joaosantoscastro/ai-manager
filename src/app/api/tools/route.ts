import { NextRequest, NextResponse } from "next/server";
import { loadServerTools } from "@/core/tool-loader";
import {
  readManagedState,
  setToolLoadResult,
  setToolLoadResults,
  setOAuthRecord,
  clearOAuthTokens,
} from "@/core/state";
import { getSourceGraph, invalidateSourceGraphCache } from "@/core/graph-cache";
import { nodeKey } from "@/core/types";
import type { ToolLoadResult, OAuthRecord } from "@/core/types";
import { configFor, mapWithLimit } from "@/core/mcp-server-config";
import { refreshAccessToken } from "@/core/mcp-oauth";

/**
 * Starting an MCP server is expensive: a stdio server is a real child
 * process, and a cold `npx`/`uvx` start can take seconds. Loading every
 * server at once would spawn all of them together, so this caps how many
 * run concurrently.
 */
const MAX_CONCURRENT_LOADS = 3;

/**
 * How long a failed read is left alone before the bulk sweep will retry it
 * on its own. Without this, a server that failed once (a cold `npx`
 * download that raced the timeout, a momentary network blip) would stay
 * failed forever: the sweep below only ever contacted servers with no
 * cache entry at all, and a failure is still an entry.
 */
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

function isDueForRetry(cached: ToolLoadResult | undefined): boolean {
  if (!cached) return true;
  if (cached.ok) return false;
  return Date.now() - new Date(cached.at).getTime() >= RETRY_COOLDOWN_MS;
}

/** Renews an access token within this window of its reported expiry, not just after it. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Resolves the bearer token to send for one server, refreshing it first if
 * it is expired (or close to it) and a refresh token is on hand. A stale
 * access token would otherwise cost a full extra round trip through the
 * loader — attach, get a 401, then the user has to explicitly retry.
 */
async function resolveAccessToken(
  mcpNodeKey: string,
  oauth: Record<string, OAuthRecord>,
): Promise<string | undefined> {
  const record = oauth[mcpNodeKey];
  if (!record?.accessToken) return undefined;

  const expired =
    record.expiresAt !== undefined &&
    Date.now() >= record.expiresAt - EXPIRY_SKEW_MS;
  if (!expired) return record.accessToken;

  if (record.refreshToken) {
    const refreshed = await refreshAccessToken({
      tokenEndpoint: record.tokenEndpoint,
      refreshToken: record.refreshToken,
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      resource: record.resourceUrl,
    });
    if (refreshed) {
      await setOAuthRecord(mcpNodeKey, {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? record.refreshToken,
        expiresAt: refreshed.expiresAt,
        updatedAt: new Date().toISOString(),
      });
      return refreshed.accessToken;
    }
  }

  // The token is past its expiry and could not be renewed. Sending it
  // anyway just draws a 401; dropping it makes the loader report
  // `needsAuth` instead, which is what the UI turns into "Sign in again".
  // The client registration survives, so that is one click, not a re-setup.
  await clearOAuthTokens(mcpNodeKey);
  return undefined;
}

/**
 * Discards tokens that a server has just rejected.
 *
 * A token can die before its stated expiry — revoked, or scoped to
 * something that changed. Without this the record would sit there looking
 * valid and every future read would spend a round trip earning the same
 * 401.
 */
async function forgetRejectedToken(
  mcpNodeKey: string,
  hadToken: boolean,
  result: ToolLoadResult,
): Promise<void> {
  if (hadToken && result.needsAuth) await clearOAuthTokens(mcpNodeKey);
}

/**
 * GET /api/tools?key=<mcp nodeKey> — returns the cached tool inventory for
 * a server, or 404 when it has never been read. Read-only: it never starts
 * anything, so a detail page can show what it already knows for free.
 *
 * Keyed by `nodeKey`, not the bare server name — two different plugins can
 * declare a same-named server (seen for real: both rc-plugin and
 * rhub-plugin ship "density-mcp"), and a bare-name key would conflate them.
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const state = await readManagedState();
  const cached = state.toolCache[key];
  if (!cached) {
    return NextResponse.json(
      { error: "This server's tools have not been read yet." },
      { status: 404 },
    );
  }
  return NextResponse.json(cached);
}

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

/**
 * POST /api/tools — starts MCP servers just long enough to call
 * `tools/list`, then kills them. This is the only way the app learns the
 * real tool inventory behind a wildcard (`tools: ["*"]`) or absent `tools`
 * declaration: the config only ever holds a filter, never the inventory.
 *
 * Body:
 *   `{ key }`     one server, always re-read.
 *   `{}`          every discovered server, skipping any already cached
 *                 successfully, retrying failures older than the cooldown.
 *   `{ force }`   with no key, re-reads every server even if cached.
 */
export async function POST(request: NextRequest) {
  let body: { key?: string; force?: boolean };
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid "load everything" request.
    body = {};
  }

  const source = await getSourceGraph();
  const state = await readManagedState();

  if (body.key) {
    const mcpNode = source.nodes.find(
      (n) => n.id.kind === "mcp" && nodeKey(n.id) === body.key,
    );
    if (!mcpNode) {
      return NextResponse.json(
        { error: "That MCP server was not found in the discovered setup." },
        { status: 404 },
      );
    }

    const config = configFor(mcpNode, state.proxiedServers);
    if (!config) {
      return NextResponse.json(
        { error: "Server config has no transport type." },
        { status: 400 },
      );
    }

    const accessToken = await resolveAccessToken(body.key, state.oauth);
    const result = await loadServerTools(mcpNode.id.name, config, accessToken);
    await forgetRejectedToken(body.key, Boolean(accessToken), result);
    await setToolLoadResult(body.key, result);
    // The next graph read must see the fresh inventory.
    invalidateSourceGraphCache();
    return NextResponse.json(result);
  }

  const servers = source.nodes.filter((n) => n.id.kind === "mcp");
  const pending = servers.filter(
    (n) => body.force || isDueForRetry(state.toolCache[nodeKey(n.id)]),
  );

  if (pending.length === 0) {
    return NextResponse.json({
      results: {},
      loaded: 0,
      skipped: servers.length,
    });
  }

  const loaded = await mapWithLimit(
    pending,
    MAX_CONCURRENT_LOADS,
    async (node): Promise<[string, ToolLoadResult]> => {
      const key = nodeKey(node.id);
      const config = configFor(node, state.proxiedServers);
      if (!config) {
        return [
          key,
          {
            server: node.id.name,
            tools: [],
            ok: false,
            at: new Date().toISOString(),
            error: "Server config has no transport type.",
          },
        ];
      }
      const accessToken = await resolveAccessToken(key, state.oauth);
      const result = await loadServerTools(node.id.name, config, accessToken);
      await forgetRejectedToken(key, Boolean(accessToken), result);
      return [key, result];
    },
  );

  const results = Object.fromEntries(loaded);
  // One write for the whole batch: a write per server would race, and the
  // last read-modify-write would drop everything the others had stored.
  await setToolLoadResults(results);
  invalidateSourceGraphCache();

  return NextResponse.json({
    results,
    loaded: pending.length,
    skipped: servers.length - pending.length,
  });
}
