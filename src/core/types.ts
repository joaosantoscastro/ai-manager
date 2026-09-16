/**
 * Core domain model shared across adapters, state, and the UI.
 *
 * This module has no dependency on Next.js, the filesystem, or the Copilot
 * CLI. It only describes shapes. See `docs/ARCHITECTURE.md` for the data
 * flow this model participates in.
 */

export type Scope =
  "user" | "repository" | "plugin" | "builtin" | "workspace" | "unknown";

export type Kind =
  | "plugin"
  | "mcp"
  | "tool"
  | "skill"
  | "agent"
  | "hook"
  | "command"
  | "instruction";

/** Stable, human-inspectable identifier for any node in the graph. */
export interface NodeId {
  kind: Kind;
  /** Unique within (kind, scope, parent). For tools this is the tool name. */
  name: string;
  scope: Scope;
  /** Present for nodes that only make sense under a parent, e.g. a tool under an MCP server. */
  parentKey?: string;
}

/** Serializes a NodeId into the flat string key used for maps and overrides. */
export function nodeKey(id: NodeId): string {
  const parent = id.parentKey ? `${id.parentKey}::` : "";
  return `${id.kind}:${id.scope}:${parent}${id.name}`;
}

/**
 * How (or whether) a node's enabled state can be changed, and by what
 * mechanism the change is ultimately written back to the Copilot config.
 */
export type ControlMode =
  | { type: "settingsPluginToggle" }
  | { type: "settingsMcpToggle" }
  | { type: "settingsSkillToggle" }
  | {
      type: "mcpToolFilter";
      server: string;
      /** Where the tools[] array for this server is declared. */
      declaredIn: "user" | "plugin";
      /**
       * Writable directly only when declaredIn === "user". Plugin-declared
       * servers require the proxy fallback (see docs/ARCHITECTURE.md 2.8).
       */
      writable: "direct" | "proxy-required";
    }
  /**
   * An individual hook entry in a `hooks.<event>[]` array. Copilot has no
   * per-hook enable setting, so the only mechanism is to remove the entry
   * from the file — which is why `core/state.ts` stashes the removed entry
   * verbatim under `disabledHooks` and discovery merges it back in.
   */
  | {
      type: "hookToggle";
      /**
       * `settings` means the entries live under `~/.copilot/settings.json`'s
       * top-level `hooks` key, which `emit.ts` must edit through the settings
       * object it is already building rather than as a separate file.
       */
      target: "settings" | "hooksFile";
      /** Absolute path of the file that declares (or declared) the entries. */
      file: string;
    }
  /** The global `disableAllHooks` switch in settings.json. */
  | { type: "settingsAllHooksToggle" }
  | { type: "readonly"; reason: string };

export interface SourceNode {
  id: NodeId;
  displayName: string;
  description?: string;
  /** Enabled state as read from disk, before any managed override is applied. */
  sourceEnabled: boolean;
  controllable: ControlMode;
  /** Absolute paths of files that make up this entity, when known. */
  files: string[];
  /** Original config fragment, kept for the raw-config detail panel. */
  raw: unknown;
  /** The plugin (or user scope) this node was contributed by. */
  providedBy?: NodeId;
  /** Child nodes this entity makes available (MCP -> tools, plugin -> mcp/skill/agent). */
  provides: NodeId[];
  version?: string;
}

export interface SourceGraph {
  nodes: SourceNode[];
  generatedAt: string;
  /** Non-fatal problems encountered during discovery (e.g. a source that failed to parse). */
  warnings: string[];
}

/**
 * A single pending enable/disable decision. These are never persisted:
 * they live in the browser's state service until the user applies or
 * cancels them, and are posted to `/api/diff` and `/api/apply` as a set.
 */
export interface Override {
  enabled: boolean;
}

/** Overrides keyed by `nodeKey(id)`, as sent from the browser to the API. */
export type OverrideMap = Record<string, Override>;

/**
 * Validates an override map arriving from the network.
 *
 * Returns `null` when the input is not a well-formed map, so the caller can
 * reject the request. Anything looser is dangerous: a bare `true` instead of
 * `{ enabled: true }` reads as "not enabled" further down, which would plan
 * the exact opposite of what the user asked for and write it to their real
 * configuration.
 */
export function parseOverrideMap(input: unknown): OverrideMap | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;

  const parsed: OverrideMap = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "object" || value === null) return null;
    const { enabled } = value as { enabled?: unknown };
    if (typeof enabled !== "boolean") return null;
    parsed[key] = { enabled };
  }
  return parsed;
}

export interface McpTool {
  name: string;
  description?: string;
}

export interface ToolLoadResult {
  server: string;
  /**
   * The server's real tool inventory as returned by `tools/list`. This is
   * the source of truth for "which tools does this server provide" — the
   * `tools[]` array in mcp-config.json is only an allowlist filter over it,
   * never the inventory itself (a wildcard `["*"]` or absent `tools` means
   * "everything", not "nothing").
   */
  tools: McpTool[];
  at: string;
  ok: boolean;
  error?: string;
  /**
   * Set when this result failed but `tools` was backfilled from the last
   * successful read rather than left empty. The UI uses this to keep
   * showing a known inventory instead of an empty "unavailable" state —
   * a single flaky request should never make 98 known tools disappear.
   */
  stale?: boolean;
  /**
   * Set when the failure was an HTTP 401/403 carrying a standard MCP
   * OAuth challenge. The UI offers a "Sign in" action instead of just an
   * error when this is present.
   */
  needsAuth?: boolean;
  /** The parsed `WWW-Authenticate` challenge, kept for the OAuth start route. */
  authChallenge?: OAuthChallenge;
  /** Protocol version the server actually negotiated in `initialize`. */
  protocolVersion?: string;
}

/** A parsed RFC 9728 `WWW-Authenticate: Bearer` challenge. */
export interface OAuthChallenge {
  resourceMetadataUrl?: string;
  authorizationUri?: string;
  scope?: string;
}

export interface ManagedState {
  version: 1;
  /** Tool inventories read from live servers, keyed by mcp NodeId key. */
  toolCache: Record<string, ToolLoadResult>;
  /**
   * Original (pre-proxy) upstream config for plugin-declared MCP servers
   * whose tools we had to filter via the proxy fallback, keyed by the
   * server's mcp NodeId key. Needed because once we rewrite the plugin's
   * `.mcp.json` to launch the proxy, that file no longer holds the real
   * upstream config — this is the only place it survives.
   */
  proxiedServers: Record<string, unknown>;
  /**
   * Hooks the user switched off, keyed by the hook's NodeId key. Copilot has
   * no per-hook enable setting, so disabling one means deleting its entry
   * from the declaring file. This is the only place that entry survives:
   * discovery merges these back in as disabled nodes, so a disabled hook
   * stays listed and can be switched on again.
   */
  disabledHooks: Record<string, DisabledHookRecord>;
  /**
   * OAuth client registrations and tokens for HTTP/SSE MCP servers that
   * require sign-in, keyed by the server's mcp NodeId key. This file is
   * outside `~/.copilot` and is never written back into Copilot's own
   * config, so a server's OAuth state here is private to this app — it
   * does not reuse or touch the CLI's own keychain-stored tokens.
   */
  oauth: Record<string, OAuthRecord>;
  /**
   * An in-flight authorization attempt, keyed by the random `state` value
   * sent to the authorization server. Needed so the callback route can
   * recover which server key and PKCE verifier a redirect belongs to.
   */
  pendingOAuth: Record<string, PendingOAuth>;
  /**
   * Client credentials the user registered by hand with a provider,
   * keyed by the server's mcp NodeId key. Kept separate from `oauth` so
   * they survive signing out: the tokens are disposable, but re-typing a
   * client id and secret from a developer console is not.
   */
  manualOAuthClients: Record<string, ManualOAuthClient>;
}

/**
 * Where a server's OAuth `client_id` came from. Dynamic registration is
 * optional in the spec and plenty of real authorization servers either
 * never offered it or have since closed it, so the app has to be able to
 * get a client another way — and the user has to be told which, because
 * the provider's consent screen shows *that* client's name, not this
 * app's.
 */
export type OAuthClientSource = "dcr" | "cli-import" | "manual";

/** A `client_id` (and its bound redirect URI) resolved from some source. */
export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret?: string;
  /**
   * The redirect URI this client is registered against. Sources other than
   * dynamic registration bring their own, which the app does not control
   * and cannot change — token exchange validates it.
   */
  redirectUri: string;
  source: OAuthClientSource;
}

/** Client credentials the user supplied by hand for one server. */
export interface ManualOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** Omitted means "registered against this app's own callback URL". */
  redirectUri?: string;
}

/** A registered OAuth client plus whatever tokens it currently holds. */
export interface OAuthRecord {
  serverUrl: string;
  authorizationServerUrl: string;
  /** Needed to refresh a token without repeating discovery every time. */
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  clientSource?: OAuthClientSource;
  redirectUri: string;
  resourceUrl?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent means unknown expiry (treat as still valid until a 401). */
  expiresAt?: number;
  updatedAt: string;
}

/** State stashed between starting a sign-in and its redirect landing back. */
export interface PendingOAuth {
  serverKey: string;
  /** The MCP server's own URL, stashed so the callback can fill in `OAuthRecord.serverUrl` without redoing discovery. */
  serverUrl: string;
  authorizationServerUrl: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  clientSource?: OAuthClientSource;
  resourceUrl?: string;
  scope?: string;
  createdAt: string;
}

/**
 * One raw array entry removed from a `hooks.<event>[]` array, captured
 * exactly as it appeared so re-enabling restores it byte-for-byte.
 */
export interface DisabledHookEntry {
  /** The event key verbatim — `preToolUse` and `PreToolUse` are both real. */
  event: string;
  /** Position within that event's array, so re-insert keeps the run order. */
  index: number;
  /** The removed object itself. */
  entry: Record<string, unknown>;
}

/**
 * A disabled logical hook.
 *
 * One logical hook can own several raw entries: plugins routinely declare
 * the same script twice, under the camelCase and the PascalCase spelling of
 * the same event, and both have to come out and go back together.
 *
 * The display fields are duplicated here because a disabled hook is, by
 * definition, absent from its file — there is nothing left on disk to read
 * them from when the list is rendered.
 */
export interface DisabledHookRecord {
  file: string;
  target: "settings" | "hooksFile";
  /** Normalized (camelCase) event name. */
  event: string;
  command: string;
  matcher?: string;
  timeoutSec?: number;
  scope: Scope;
  pluginName?: string;
  /** `nodeKey` of the providing plugin, when the hook came from one. */
  providedByKey?: string;
  entries: DisabledHookEntry[];
  disabledAt: string;
}

export type EffectiveReason =
  | { type: "source" }
  | { type: "overridden" }
  | { type: "disabledByParent"; parentKey: string };

export interface ResolvedNode extends SourceNode {
  effectiveEnabled: boolean;
  overridden: boolean;
  effectiveReason: EffectiveReason;
}

export interface ResolvedGraph {
  nodes: ResolvedNode[];
  generatedAt: string;
  warnings: string[];
}
