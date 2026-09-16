/**
 * Shared discovery for the OAuth routes: turns a server's cached
 * `WWW-Authenticate` challenge into the endpoints needed to sign in.
 */
import { readManagedState } from "@/core/state";
import { getSourceGraph } from "@/core/graph-cache";
import { nodeKey } from "@/core/types";
import { configFor } from "@/core/mcp-server-config";
import {
  fetchAuthServerMetadata,
  fetchProtectedResourceMetadata,
  type AuthServerMetadata,
} from "@/core/mcp-oauth";
import type { ManualOAuthClient } from "@/core/types";

export interface DiscoveryFailure {
  error: string;
  status: number;
}

export interface DiscoveredServer {
  serverUrl: string;
  issuer: string;
  resourceUrl: string;
  scope?: string;
  authServerMeta: AuthServerMetadata;
  manual?: ManualOAuthClient;
}

export function isFailure(
  value: DiscoveredServer | DiscoveryFailure,
): value is DiscoveryFailure {
  return "error" in value;
}

/**
 * Resolves everything about one MCP server that a sign-in needs, short of
 * the client itself: its URL, its authorization server, and that server's
 * metadata.
 */
export async function discoverServer(
  key: string,
): Promise<DiscoveredServer | DiscoveryFailure> {
  const state = await readManagedState();
  const challenge = state.toolCache[key]?.authChallenge;
  if (!challenge) {
    return {
      error:
        "No authorization challenge on record for this server. Read its tools first.",
      status: 400,
    };
  }

  const source = await getSourceGraph();
  const mcpNode = source.nodes.find(
    (n) => n.id.kind === "mcp" && nodeKey(n.id) === key,
  );
  if (!mcpNode) {
    return {
      error: "That MCP server was not found in the discovered setup.",
      status: 404,
    };
  }
  const config = configFor(mcpNode, state.proxiedServers);
  if (!config || !("url" in config)) {
    return {
      error: "Server config has no HTTP transport to sign in against.",
      status: 400,
    };
  }

  // RFC 9728: the protected-resource metadata (when advertised) names the
  // authorization server(s) that can mint tokens for this resource, and
  // the canonical resource identifier to request a token for.
  let issuer: string | undefined;
  let resourceUrl = config.url;
  let scope = challenge.scope;
  if (challenge.resourceMetadataUrl) {
    const prm = await fetchProtectedResourceMetadata(
      challenge.resourceMetadataUrl,
    );
    issuer = prm?.authorization_servers?.[0];
    if (prm?.resource) resourceUrl = prm.resource;
    if (!scope) scope = prm?.scopes_supported?.[0];
  }
  // Some servers put the issuer directly in `authorization_uri` instead of
  // (or alongside) pointing at protected-resource metadata.
  issuer ??= challenge.authorizationUri;
  if (!issuer) {
    return {
      error:
        "This server's authorization challenge did not name an authorization server.",
      status: 502,
    };
  }

  const authServerMeta = await fetchAuthServerMetadata(issuer);
  if (!authServerMeta) {
    return {
      error: `Could not discover authorization server metadata for ${issuer}.`,
      status: 502,
    };
  }
  if (!scope) scope = authServerMeta.scopes_supported?.[0];

  return {
    serverUrl: config.url,
    issuer,
    resourceUrl,
    scope,
    authServerMeta,
    manual: state.manualOAuthClients[key],
  };
}
