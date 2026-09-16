/**
 * Reads OAuth client registrations the Copilot CLI already performed on
 * this machine, so a server whose authorization server no longer hands out
 * new clients can still be signed into.
 *
 * This reads *client registrations* only — a `client_id`, and the redirect
 * URI it is bound to. It deliberately does not touch the CLI's
 * keychain-stored access tokens: the user still signs in themselves, in
 * the provider's own window. Borrowing a registration means the consent
 * screen shows that client's name, which callers are expected to surface.
 *
 * The CLI names these files after a hash of something that could not be
 * reproduced here, so nothing keys off the filename. Every file in the
 * directory is read and matched on the server URL recorded *inside* it,
 * which works for any server the CLI has authenticated rather than a
 * hardcoded list.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI_OAUTH_CONFIG_DIR =
  process.env.COPILOT_MCP_OAUTH_CONFIG_DIR ||
  join(homedir(), ".copilot", "mcp-oauth-config");

interface CliOAuthConfigFile {
  serverUrl?: string;
  resourceUrl?: string;
  authorizationServerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface CliOAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  authorizationServerUrl?: string;
  resourceUrl?: string;
}

/**
 * Compares two URLs as OAuth resource identifiers: case-insensitive, and
 * indifferent to a trailing slash. `https://mcp.example.com/mcp` and
 * `https://MCP.example.com/mcp/` name the same resource, and configs on
 * disk are not consistent about either.
 */
function sameResource(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Finds a client the CLI registered for `serverUrl`, or null when the
 * directory is absent, unreadable, or holds nothing for that server.
 *
 * A missing directory is the normal case for anyone not running the CLI,
 * so it is not an error.
 */
export async function findCliOAuthClient(
  serverUrl: string,
): Promise<CliOAuthClient | null> {
  let entries: string[];
  try {
    entries = await readdir(CLI_OAUTH_CONFIG_DIR);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let parsed: CliOAuthConfigFile;
    try {
      const raw = await readFile(join(CLI_OAUTH_CONFIG_DIR, entry), "utf8");
      parsed = JSON.parse(raw) as CliOAuthConfigFile;
    } catch {
      // A half-written or hand-edited file must not abort the whole scan.
      continue;
    }
    const matches =
      sameResource(parsed.serverUrl, serverUrl) ||
      sameResource(parsed.resourceUrl, serverUrl);
    if (!matches) continue;
    if (!parsed.clientId || !parsed.redirectUri) continue;
    return {
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      redirectUri: parsed.redirectUri,
      authorizationServerUrl: parsed.authorizationServerUrl,
      resourceUrl: parsed.resourceUrl,
    };
  }
  return null;
}
