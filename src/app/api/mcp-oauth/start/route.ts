import { NextRequest, NextResponse } from "next/server";
import { setPendingOAuth } from "@/core/state";
import {
  buildAuthorizeUrl,
  makePkcePair,
  randomToken,
  resolveOAuthClient,
} from "@/core/mcp-oauth";
import { startLoopbackRelay, LoopbackRelayError } from "@/core/loopback-relay";
import { discoverServer, isFailure } from "../discover";

/** Where a client this app registers itself sends the user back to. */
function ownRedirectUri(request: NextRequest): string {
  return new URL("/api/mcp-oauth/callback", request.nextUrl.origin).toString();
}

/**
 * POST /api/mcp-oauth/start — begins a sign-in for one OAuth-protected MCP
 * server and hands back the URL of the provider's own auth window.
 *
 * Getting there needs a `client_id`, and dynamic registration — the only
 * way to obtain one automatically — is optional in the spec. Servers that
 * never offered it, or have since closed it, would otherwise be
 * unreachable. `resolveOAuthClient` therefore tries several sources and
 * reports which one answered, since the consent screen shows *that*
 * client's name.
 *
 * Body: `{ key }` — the server's mcp NodeId key, the same one `/api/tools`
 * uses. Discovery needs that server's last `authChallenge`, so tools must
 * have been read at least once (which is how the UI learns `needsAuth` in
 * the first place, so this is always true by the time a "Sign in" button
 * exists to click).
 */
export async function POST(request: NextRequest) {
  let body: { key?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const key = body.key;
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const discovered = await discoverServer(key);
  if (isFailure(discovered)) {
    return NextResponse.json(
      { error: discovered.error },
      { status: discovered.status },
    );
  }

  const redirectUri = ownRedirectUri(request);
  const client = await resolveOAuthClient({
    serverUrl: discovered.serverUrl,
    ownRedirectUri: redirectUri,
    registrationEndpoint: discovered.authServerMeta.registration_endpoint,
    tokenEndpointAuthMethodsSupported:
      discovered.authServerMeta.token_endpoint_auth_methods_supported,
    manual: discovered.manual,
  });

  if (!client) {
    // Every automatic source is exhausted. This is recoverable — the user
    // can register an app with the provider themselves — so say so in a
    // form the UI can act on, rather than as a dead end.
    return NextResponse.json(
      {
        error:
          "This provider does not hand out OAuth clients automatically, so the app needs credentials from an app you register with it.",
        needsManualClient: true,
        redirectUri,
        authorizationServerUrl: discovered.issuer,
      },
      { status: 428 },
    );
  }

  // A client from anywhere but our own registration carries its own
  // redirect URI, which the token endpoint will insist on. Receive the
  // redirect at that address and forward it back to the callback route.
  try {
    await startLoopbackRelay(client.redirectUri, request.nextUrl.origin);
  } catch (err) {
    if (err instanceof LoopbackRelayError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const { verifier, challenge: codeChallenge } = makePkcePair();
  const stateParam = randomToken();

  await setPendingOAuth(stateParam, {
    serverKey: key,
    serverUrl: discovered.serverUrl,
    authorizationServerUrl: discovered.issuer,
    codeVerifier: verifier,
    redirectUri: client.redirectUri,
    tokenEndpoint: discovered.authServerMeta.token_endpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    clientSource: client.source,
    resourceUrl: discovered.resourceUrl,
    scope: discovered.scope,
    createdAt: new Date().toISOString(),
  });

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovered.authServerMeta.authorization_endpoint,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    state: stateParam,
    codeChallenge,
    scope: discovered.scope,
    resource: discovered.resourceUrl,
  });

  return NextResponse.json({ authorizeUrl, clientSource: client.source });
}
