/**
 * Persistence for the application's own managed state: cached MCP tool
 * inventories, and the original config of servers the proxy now fronts.
 * Lives entirely outside `~/.copilot` — this file never touches the
 * original Copilot config; `core/emit.ts` is the only module that does
 * that, and only when explicitly asked to `apply`.
 *
 * Pending enable/disable decisions are deliberately *not* stored here.
 * They live in the browser's state service (`src/ui/SetupState.tsx`) until
 * the user applies or cancels them, so a click costs no disk write and no
 * request. Old state files may still carry an `overrides` key; it is
 * ignored on read and dropped on the next write.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type {
  DisabledHookRecord,
  ManagedState,
  ManualOAuthClient,
  OAuthRecord,
  PendingOAuth,
  ToolLoadResult,
} from "./types";

const STATE_DIR =
  process.env.AI_SETUP_MANAGER_HOME || join(homedir(), ".ai-setup-manager");
const STATE_FILE = join(STATE_DIR, "managed-state.json");

/**
 * How long an unfinished sign-in is kept. A user who opens the auth window
 * and abandons it leaves a `pendingOAuth` entry behind; without an expiry
 * those accumulate in the state file forever.
 */
const PENDING_OAUTH_TTL_MS = 30 * 60 * 1000;

/**
 * A fresh, fully-owned empty state.
 *
 * A shared `EMPTY_STATE` constant would only ever be spread at the top
 * level, leaving every caller pointing at the same nested maps — so the
 * first `setProxiedServerOriginal` after a failed read would write into the
 * module constant and leak into every later read.
 */
function emptyState(): ManagedState {
  return {
    version: 1,
    toolCache: {},
    proxiedServers: {},
    disabledHooks: {},
    oauth: {},
    pendingOAuth: {},
    manualOAuthClients: {},
  };
}

export function getStateDir(): string {
  return STATE_DIR;
}

export function getSnapshotsDir(): string {
  return join(STATE_DIR, "snapshots");
}

/** Drops sign-in attempts too old to still be completed. */
function withoutExpiredPending(
  pending: Record<string, PendingOAuth>,
): Record<string, PendingOAuth> {
  const cutoff = Date.now() - PENDING_OAUTH_TTL_MS;
  return Object.fromEntries(
    Object.entries(pending).filter(
      ([, entry]) => new Date(entry.createdAt).getTime() >= cutoff,
    ),
  );
}

export async function readManagedState(): Promise<ManagedState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedState>;
    return {
      version: 1,
      toolCache: parsed.toolCache ?? {},
      proxiedServers: parsed.proxiedServers ?? {},
      disabledHooks: parsed.disabledHooks ?? {},
      oauth: parsed.oauth ?? {},
      pendingOAuth: withoutExpiredPending(parsed.pendingOAuth ?? {}),
      manualOAuthClients: parsed.manualOAuthClients ?? {},
    };
  } catch {
    return emptyState();
  }
}

/** Atomic write: write to a temp file in the same directory, then rename over the target. */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // The directory holds OAuth tokens and snapshots of the user's config, so
  // it must not be traversable by other accounts on the machine. `mkdir`'s
  // mode is masked by the umask, so it is set explicitly here instead.
  await chmod(dir, 0o700).catch(() => {});
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, contents, "utf8");
  await rename(tmpPath, path);
  // This file now holds OAuth client secrets and access/refresh tokens, so
  // it must not be group/world readable. `chmod` after `rename` because a
  // freshly created temp file already inherits the umask; this just makes
  // the guarantee explicit and independent of the process umask.
  await chmod(path, 0o600).catch(() => {
    // Non-fatal: some filesystems (network shares, certain CI sandboxes)
    // reject chmod entirely. The write itself already succeeded.
  });
}

export async function writeManagedState(state: ManagedState): Promise<void> {
  await writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Combines a fresh `ToolLoadResult` with whatever was cached before.
 *
 * A failed read must never erase a previously known inventory: the whole
 * point of caching is that a wildcard server's tool list survives a
 * transient network blip. When the new result failed but a previous
 * successful read exists, the previous `tools` are kept and the result is
 * flagged `stale` so the UI can show a warning instead of an empty state.
 * A successful read always replaces the cache outright — including
 * clearing any earlier `stale` flag.
 */
export function mergeToolLoadResult(
  previous: ToolLoadResult | undefined,
  incoming: ToolLoadResult,
): ToolLoadResult {
  if (incoming.ok) return incoming;
  if (previous && previous.tools.length > 0) {
    return { ...incoming, tools: previous.tools, stale: true };
  }
  return incoming;
}

/**
 * Caches a tool inventory under the server's `nodeKey`, not its bare name —
 * two different plugins can declare a same-named server (seen for real:
 * both rc-plugin and rhub-plugin ship "density-mcp"), and a bare-name key
 * would silently merge their results.
 */
export async function setToolLoadResult(
  mcpNodeKey: string,
  result: ToolLoadResult,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.toolCache[mcpNodeKey] = mergeToolLoadResult(
    state.toolCache[mcpNodeKey],
    result,
  );
  await writeManagedState(state);
  return state;
}

/**
 * Stores several inventories in one write. Loading every server at once
 * would otherwise read-modify-write the same file per server and lose
 * results to the race between them.
 */
export async function setToolLoadResults(
  results: Record<string, ToolLoadResult>,
): Promise<ManagedState> {
  const state = await readManagedState();
  for (const [key, result] of Object.entries(results)) {
    state.toolCache[key] = mergeToolLoadResult(state.toolCache[key], result);
  }
  await writeManagedState(state);
  return state;
}

/** Stashes the true original upstream config for a server the proxy now fronts. */
export async function setProxiedServerOriginal(
  mcpNodeKey: string,
  originalConfig: unknown,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.proxiedServers[mcpNodeKey] = originalConfig;
  await writeManagedState(state);
  return state;
}

/** Clears the stash once a server no longer needs the proxy (all its tools re-enabled). */
export async function clearProxiedServerOriginal(
  mcpNodeKey: string,
): Promise<ManagedState> {
  const state = await readManagedState();
  delete state.proxiedServers[mcpNodeKey];
  await writeManagedState(state);
  return state;
}

/**
 * Stashes the raw entries of a hook the user switched off.
 *
 * Copilot has no per-hook enable setting, so `core/emit.ts` disables a hook
 * by deleting its entries from the declaring file. Without this stash the
 * hook would be gone for good: there would be nothing left to list, and
 * nothing to put back when the user switches it on again.
 */
export async function setDisabledHook(
  hookNodeKey: string,
  record: DisabledHookRecord,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.disabledHooks[hookNodeKey] = record;
  await writeManagedState(state);
  return state;
}

/** Drops the stash once the hook's entries are back in its file. */
export async function clearDisabledHook(
  hookNodeKey: string,
): Promise<ManagedState> {
  const state = await readManagedState();
  delete state.disabledHooks[hookNodeKey];
  await writeManagedState(state);
  return state;
}

/** Reads the stored OAuth client/tokens for one server, if any. */
export async function getOAuthRecord(
  mcpNodeKey: string,
): Promise<OAuthRecord | undefined> {
  const state = await readManagedState();
  return state.oauth[mcpNodeKey];
}

/** Stores (or replaces) the OAuth client registration and/or tokens for one server. */
export async function setOAuthRecord(
  mcpNodeKey: string,
  record: OAuthRecord,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.oauth[mcpNodeKey] = record;
  await writeManagedState(state);
  return state;
}

/**
 * Drops a server's stored OAuth client and tokens, e.g. on sign-out or a
 * hard auth failure. Also drops its cached tool list: that cache was
 * populated using the credentials just invalidated, so leaving it in
 * place would keep showing tools as if still signed in until the next
 * scheduled sweep or a manual force-reload.
 */
export async function clearOAuthRecord(
  mcpNodeKey: string,
): Promise<ManagedState> {
  const state = await readManagedState();
  delete state.oauth[mcpNodeKey];
  delete state.toolCache[mcpNodeKey];
  await writeManagedState(state);
  return state;
}

/**
 * Stashes a pending authorization attempt under the random `state` value
 * sent to the authorization server, so the callback route — which only
 * receives that value and a code — can recover which server and PKCE
 * verifier it belongs to.
 */
export async function setPendingOAuth(
  stateParam: string,
  pending: PendingOAuth,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.pendingOAuth[stateParam] = pending;
  await writeManagedState(state);
  return state;
}

/** Reads and removes a pending authorization attempt in one step (single-use). */
export async function takePendingOAuth(
  stateParam: string,
): Promise<PendingOAuth | undefined> {
  const state = await readManagedState();
  const pending = state.pendingOAuth[stateParam];
  if (pending) {
    delete state.pendingOAuth[stateParam];
    await writeManagedState(state);
  }
  return pending;
}

/**
 * Discards a server's tokens while keeping its client registration.
 *
 * Used when a refresh fails or a stored token still draws a 401: the
 * tokens are dead, but the client is not, and making the user re-enter
 * credentials they registered by hand would be gratuitous.
 */
export async function clearOAuthTokens(
  mcpNodeKey: string,
): Promise<ManagedState> {
  const state = await readManagedState();
  const record = state.oauth[mcpNodeKey];
  if (record) {
    delete record.accessToken;
    delete record.refreshToken;
    delete record.expiresAt;
    record.updatedAt = new Date().toISOString();
    await writeManagedState(state);
  }
  return state;
}

/** Stores client credentials the user registered with a provider by hand. */
export async function setManualOAuthClient(
  mcpNodeKey: string,
  client: ManualOAuthClient,
): Promise<ManagedState> {
  const state = await readManagedState();
  state.manualOAuthClients[mcpNodeKey] = client;
  await writeManagedState(state);
  return state;
}

/** Forgets hand-entered client credentials for one server. */
export async function clearManualOAuthClient(
  mcpNodeKey: string,
): Promise<ManagedState> {
  const state = await readManagedState();
  delete state.manualOAuthClients[mcpNodeKey];
  await writeManagedState(state);
  return state;
}
