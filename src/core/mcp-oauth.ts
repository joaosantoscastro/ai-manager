/**
 * MCP OAuth client: discovery, dynamic client registration, and the
 * authorization-code + PKCE exchange used to sign in to an HTTP/SSE MCP
 * server that answers `tools/list` with 401.
 *
 * This app never reads the Copilot CLI's own keychain-stored tokens (a
 * different process, a different trust boundary) — it registers its own
 * OAuth client per server and keeps its own tokens in `managed-state.json`
 * (see `core/state.ts`). Follows:
 *   - RFC 9728  (OAuth 2.0 Protected Resource Metadata)
 *   - RFC 8414  (OAuth 2.0 Authorization Server Metadata), with an OIDC
 *     discovery document accepted as a fallback since several servers only
 *     publish that one
 *   - RFC 7591  (OAuth 2.0 Dynamic Client Registration)
 *   - RFC 7636  (PKCE), S256 only — plain is not offered
 *   - RFC 8707  (Resource Indicators), sent as `resource` wherever a
 *     resource URL is known, per the MCP authorization spec
 */
import { createHash, randomBytes } from "node:crypto";
import { getSystemCertificates } from "./system-ca";
import { httpRequestFollowingRedirects, jsonHeaders } from "./http-client";
import { findCliOAuthClient } from "./cli-oauth-import";
import type {
  ManualOAuthClient,
  OAuthChallenge,
  ResolvedOAuthClient,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_NAME = "AI Setup Manager";

/**
 * Parses a `WWW-Authenticate: Bearer ...` challenge into its named
 * parameters. Values are always quoted per RFC 6750, so a simple
 * `key="value"` scan is sufficient — no header library is pulled in for
 * this one shape.
 */
export function parseWwwAuthenticate(header: string): OAuthChallenge {
  const params: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    params[match[1]] = match[2];
  }
  return {
    resourceMetadataUrl: params.resource_metadata,
    authorizationUri: params.authorization_uri,
    scope: params.scope,
  };
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

async function getJson<T>(url: string, ca: string[]): Promise<T | null> {
  try {
    const reply = await httpRequestFollowingRedirects(
      url,
      "GET",
      { Accept: "application/json" },
      undefined,
      ca,
      REQUEST_TIMEOUT_MS,
    );
    if (reply.status >= 400) return null;
    return JSON.parse(reply.body) as T;
  } catch {
    return null;
  }
}

/** Fetches RFC 9728 protected-resource metadata, when the challenge names its URL. */
export async function fetchProtectedResourceMetadata(
  url: string,
): Promise<ProtectedResourceMetadata | null> {
  const ca = await getSystemCertificates();
  return getJson<ProtectedResourceMetadata>(url, ca);
}

/**
 * Well-known candidate URLs for an authorization server's metadata,
 * checked in order. RFC 8414 §3.1 inserts the well-known suffix before any
 * path component on the issuer; most real servers are root-only, so the
 * simple root-suffixed form is tried first and covers the common case,
 * with the path-preserving form and an OIDC discovery document as
 * fallbacks for the rest.
 */
function candidateMetadataUrls(issuer: string): string[] {
  let origin: URL;
  try {
    origin = new URL(issuer);
  } catch {
    return [];
  }
  const path = origin.pathname === "/" ? "" : origin.pathname;
  const root = `${origin.origin}`;
  const urls = [`${root}/.well-known/oauth-authorization-server${path}`];
  if (path) urls.push(`${root}/.well-known/oauth-authorization-server`);
  urls.push(`${root}/.well-known/openid-configuration${path}`);
  if (path) urls.push(`${root}/.well-known/openid-configuration`);
  // The issuer URL itself may already be a metadata document (some
  // resource-metadata responses list the metadata URL directly rather
  // than a bare issuer).
  urls.push(issuer);
  return [...new Set(urls)];
}

/** Fetches an authorization server's metadata, trying RFC 8414 then OIDC discovery. */
export async function fetchAuthServerMetadata(
  issuer: string,
): Promise<AuthServerMetadata | null> {
  const ca = await getSystemCertificates();
  for (const url of candidateMetadataUrls(issuer)) {
    const metadata = await getJson<AuthServerMetadata>(url, ca);
    if (metadata?.authorization_endpoint && metadata?.token_endpoint) {
      return metadata;
    }
  }
  return null;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Picks how the client should authenticate at the token endpoint.
 *
 * A public PKCE client (`none`) is preferable — it means no secret to
 * store. But plenty of authorization servers do not offer it and will
 * reject a registration that asks for it, so honour whatever the server
 * advertises and only fall back to `none` when it says nothing at all.
 */
function chooseAuthMethod(supported: string[] | undefined): string {
  if (!supported || supported.length === 0) return "none";
  for (const preferred of ["none", "client_secret_post", "client_secret_basic"]) {
    if (supported.includes(preferred)) return preferred;
  }
  return supported[0];
}

/** RFC 7591 dynamic client registration. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  tokenEndpointAuthMethodsSupported?: string[],
): Promise<RegisteredClient | null> {
  const ca = await getSystemCertificates();
  const body = JSON.stringify({
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: chooseAuthMethod(
      tokenEndpointAuthMethodsSupported,
    ),
  });
  try {
    const reply = await httpRequestFollowingRedirects(
      registrationEndpoint,
      "POST",
      jsonHeaders(),
      body,
      ca,
      REQUEST_TIMEOUT_MS,
    );
    if (reply.status >= 400) return null;
    const parsed = JSON.parse(reply.body) as {
      client_id?: string;
      client_secret?: string;
    };
    if (!parsed.client_id) return null;
    return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
  } catch {
    return null;
  }
}

/**
 * Finds a usable `client_id` for one server, trying each source in turn
 * and taking the first that yields one.
 *
 * Dynamic registration is the right answer when it is available, but it is
 * optional in the spec: a server may never have offered it, or may have
 * closed it since. The later sources exist so those servers are still
 * reachable, rather than the sign-in dead-ending before the provider's own
 * auth window ever opens.
 *
 * Returns null only when every source is exhausted, which the caller
 * should turn into a prompt for credentials rather than a bare error.
 */
export async function resolveOAuthClient(params: {
  serverUrl: string;
  /** This app's own callback, used for clients it registers itself. */
  ownRedirectUri: string;
  registrationEndpoint?: string;
  tokenEndpointAuthMethodsSupported?: string[];
  /** Credentials the user already supplied for this server, if any. */
  manual?: ManualOAuthClient;
}): Promise<ResolvedOAuthClient | null> {
  // 1. The user's own credentials win when present: they went to the
  //    trouble of registering an app, so honour it over anything guessed.
  if (params.manual?.clientId) {
    return {
      clientId: params.manual.clientId,
      clientSecret: params.manual.clientSecret,
      redirectUri: params.manual.redirectUri || params.ownRedirectUri,
      source: "manual",
    };
  }

  // 2. Register a client of our own, so the consent screen carries this
  //    app's name rather than someone else's.
  if (params.registrationEndpoint) {
    const registered = await registerClient(
      params.registrationEndpoint,
      params.ownRedirectUri,
      params.tokenEndpointAuthMethodsSupported,
    );
    if (registered) {
      return {
        clientId: registered.clientId,
        clientSecret: registered.clientSecret,
        redirectUri: params.ownRedirectUri,
        source: "dcr",
      };
    }
  }

  // 3. Borrow a registration the Copilot CLI already obtained for this
  //    same server. Its redirect URI comes with it and cannot be changed.
  const imported = await findCliOAuthClient(params.serverUrl);
  if (imported) {
    return {
      clientId: imported.clientId,
      clientSecret: imported.clientSecret,
      redirectUri: imported.redirectUri,
      source: "cli-import",
    };
  }

  return null;
}

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE S256: the verifier is the secret; the challenge is its SHA-256, sent up front. */
export function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.scope) url.searchParams.set("scope", params.scope);
  // RFC 8707: tells the authorization server which resource the token is
  // for. The MCP authorization spec requires this so a token minted for
  // one MCP server cannot be replayed against another.
  if (params.resource) url.searchParams.set("resource", params.resource);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function toTokenResponse(body: string): TokenResponse | null {
  let parsed: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed.access_token) return null;
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt:
      typeof parsed.expires_in === "number"
        ? Date.now() + parsed.expires_in * 1000
        : undefined,
  };
}

function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCodeForToken(params: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  resource?: string;
}): Promise<TokenResponse | null> {
  const ca = await getSystemCertificates();
  const body = formBody({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
    resource: params.resource,
  });
  try {
    const reply = await httpRequestFollowingRedirects(
      params.tokenEndpoint,
      "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      ca,
      REQUEST_TIMEOUT_MS,
    );
    if (reply.status >= 400) return null;
    return toTokenResponse(reply.body);
  } catch {
    return null;
  }
}

/** Exchanges a refresh token for a new access token. */
export async function refreshAccessToken(params: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}): Promise<TokenResponse | null> {
  const ca = await getSystemCertificates();
  const body = formBody({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    resource: params.resource,
  });
  try {
    const reply = await httpRequestFollowingRedirects(
      params.tokenEndpoint,
      "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      ca,
      REQUEST_TIMEOUT_MS,
    );
    if (reply.status >= 400) return null;
    return toTokenResponse(reply.body);
  } catch {
    return null;
  }
}
