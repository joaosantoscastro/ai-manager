/**
 * Minimal MCP client used to ask a server what tools it actually provides.
 *
 * No SDK dependency — just enough JSON-RPC to call `initialize`, then
 * `tools/list`, then shut the server back down. This is the only way the
 * app can know a server's real inventory: the `tools[]` array in a config
 * file is an allowlist filter over that inventory, never the inventory
 * itself. Results are cached in `managed-state.json` (see core/state.ts),
 * so a server is only contacted when its tools are not already known.
 */
import { spawn } from "node:child_process";
import type { McpTool, ToolLoadResult } from "./types";
import {
  getSystemCertificates,
  isUntrustedCertificateError,
} from "./system-ca";
import {
  httpRequestFollowingRedirects,
  jsonHeaders,
  openSseGet,
  type HttpReply,
} from "./http-client";
import { parseWwwAuthenticate } from "./mcp-oauth";

export interface StdioServerConfig {
  type: "stdio" | "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * Per-request budget (a single HTTP call, or "no bytes from the child for
 * this long"). `tools/list` is typically answered before any credential is
 * used, so a server missing its real secrets can usually still be asked —
 * but cold starts (npx/uvx downloading a package) can take a while, which
 * is why the stdio side resets this on any activity rather than enforcing
 * it as one fixed deadline for the whole exchange.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Whole-exchange cap, independent of the per-request timeout above. A
 * paginated `tools/list` can take many round trips, each individually
 * fast, that should still not be allowed to run forever.
 */
const ABSOLUTE_TIMEOUT_MS = 5 * 60_000;
/** Hard cap on `tools/list` pages, so a server that never stops sending `nextCursor` cannot hang this forever. */
const MAX_TOOL_PAGES = 20;
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "local-ai-setup-manager", version: "0.1.0" };

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

function jsonRpcRequest(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params: params ?? {} };
}

function jsonRpcNotification(method: string, params?: unknown) {
  return { jsonrpc: "2.0", method, params: params ?? {} };
}

const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: CLIENT_INFO,
};

function toTools(result: unknown): McpTool[] {
  const list = (result as { tools?: { name: string; description?: string }[] })
    ?.tools;
  return (list ?? []).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

/** The `nextCursor` a paginated `tools/list` result carries, if any. */
function nextCursorOf(result: unknown): string | undefined {
  return (result as { nextCursor?: string } | undefined)?.nextCursor;
}

function protocolVersionOf(result: unknown): string | undefined {
  return (result as { protocolVersion?: string } | undefined)?.protocolVersion;
}

function failure(server: string, error: string): ToolLoadResult {
  return {
    server,
    tools: [],
    ok: false,
    at: new Date().toISOString(),
    error,
  };
}

/**
 * Turns a 401/403 into a result the UI can offer sign-in for, instead of a
 * dead-end error: the `WWW-Authenticate` challenge names where to start
 * the OAuth discovery chain (see `core/mcp-oauth.ts`).
 */
function authFailure(server: string, reply: HttpReply): ToolLoadResult {
  const header = reply.headers["www-authenticate"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  return {
    server,
    tools: [],
    ok: false,
    at: new Date().toISOString(),
    error: describeHttpStatus(reply.status, reply.body),
    needsAuth: true,
    authChallenge: headerValue ? parseWwwAuthenticate(headerValue) : undefined,
  };
}

/* -------------------------------------------------------------------------
 * stdio transport
 * ---------------------------------------------------------------------- */

/**
 * Substitutes `${VAR}` references in a single value.
 *
 * `scope` is consulted before `process.env` because a plugin server's own
 * `env` block defines the variables its other fields refer to — `cwd` is
 * routinely declared as `"${PLUGIN_ROOT}"`, and `PLUGIN_ROOT` exists only
 * in that block, never in our environment. Unresolvable references are
 * left untouched and reported, rather than being replaced with an empty
 * string that would silently turn a path into the filesystem root.
 */
function substitute(
  value: string,
  scope: Record<string, string | undefined>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    const found = scope[name] ?? process.env[name];
    if (found === undefined) {
      missing.push(name);
      return match;
    }
    return found;
  });
  return { value: resolved, missing };
}

function resolveEnv(input: Record<string, string> | undefined): {
  resolved: Record<string, string>;
  missing: string[];
} {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, raw] of Object.entries(input ?? {})) {
    const out = substitute(raw, {});
    // A reference we could not resolve is dropped rather than passed through
    // literally, so the child process sees an unset variable instead of the
    // string "${TOKEN}" — which it would try to use as a real credential.
    if (out.missing.length > 0) {
      missing.push(...out.missing);
      continue;
    }
    resolved[key] = out.value;
  }
  return { resolved, missing: [...new Set(missing)] };
}

async function loadStdioTools(
  server: string,
  config: StdioServerConfig,
): Promise<ToolLoadResult> {
  // Missing `${ENV}` placeholders are surfaced as a warning, not a hard
  // abort — `tools/list` frequently succeeds before any credential is
  // used (confirmed against a real Jira/Confluence server with no token
  // set).
  const { resolved, missing } = resolveEnv(config.env);
  const envWarning =
    missing.length > 0
      ? `Missing environment variable(s): ${missing.join(", ")}. The tools were still read, but some may be incomplete or fail at actual use.`
      : undefined;

  // `cwd` is resolved against the server's own env block first. Plugin
  // servers declare `cwd: "${PLUGIN_ROOT}"`, and ignoring it starts the
  // process in this app's directory, where any relative path it uses
  // resolves to the wrong place.
  let cwd: string | undefined;
  if (config.cwd) {
    const out = substitute(config.cwd, resolved);
    if (out.missing.length === 0) cwd = out.value;
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.command, config.args ?? [], {
        cwd,
        env: { ...process.env, ...resolved },
        stdio: ["pipe", "pipe", "pipe"],
        // A new process group on POSIX, so the group can be killed as a
        // unit below. `npx`/`uvx` routinely spawn a grandchild that does
        // the real work; killing only the direct child leaves that
        // grandchild running (and, for a cold download, still holding the
        // stdout our code no longer reads).
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve(
        failure(server, err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    let buffer = "";
    let stderr = "";
    let settled = false;
    const tools: McpTool[] = [];
    let pages = 0;
    let listRequestId = 2;
    let negotiatedProtocolVersion: string | undefined;

    const killChild = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid);
          return;
        } catch {
          // Group may already be gone, or we're not its leader for some
          // reason — fall through to killing just the child we have.
        }
      }
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    };

    const finish = (result: ToolLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      killChild();
      resolve(
        envWarning && result.ok ? { ...result, error: envWarning } : result,
      );
    };

    // Reset on any activity, so a slow-starting `npx`/`uvx` download isn't
    // penalized for time spent before it printed anything — only silence
    // is timed out, not the exchange as a whole (that's `absoluteTimer`).
    let idleTimer: NodeJS.Timeout;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(
          failure(
            server,
            `Timed out after ${REQUEST_TIMEOUT_MS}ms with no response from the server.`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
    };
    resetIdleTimer();

    const absoluteTimer = setTimeout(() => {
      finish(
        failure(
          server,
          `Timed out after ${ABSOLUTE_TIMEOUT_MS}ms waiting for the server to finish responding.`,
        ),
      );
    }, ABSOLUTE_TIMEOUT_MS);

    child.on("error", (err) => finish(failure(server, err.message)));

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      resetIdleTimer();
    });

    child.stdout?.on("data", (chunk) => {
      resetIdleTimer();
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish(failure(server, msg.error.message ?? "initialize failed"));
            return;
          }
          negotiatedProtocolVersion = protocolVersionOf(msg.result);
          child.stdin?.write(
            JSON.stringify(jsonRpcNotification("notifications/initialized")) +
              "\n",
          );
          child.stdin?.write(
            JSON.stringify(jsonRpcRequest(listRequestId, "tools/list")) + "\n",
          );
        } else if (msg.id === listRequestId) {
          if (msg.error) {
            finish(failure(server, msg.error.message ?? "tools/list failed"));
            return;
          }
          tools.push(...toTools(msg.result));
          pages += 1;
          const cursor = nextCursorOf(msg.result);
          if (cursor && pages < MAX_TOOL_PAGES) {
            listRequestId += 1;
            child.stdin?.write(
              JSON.stringify(
                jsonRpcRequest(listRequestId, "tools/list", { cursor }),
              ) + "\n",
            );
          } else {
            finish({
              server,
              tools,
              ok: true,
              at: new Date().toISOString(),
              protocolVersion: negotiatedProtocolVersion,
            });
          }
        }
      }
    });

    child.on("exit", () => {
      if (!settled) {
        finish(
          failure(server, stderr.trim() || "Process exited before responding."),
        );
      }
    });

    child.stdin?.on("error", () => {
      // The server can exit before we finish writing. The `exit` handler
      // above already reports that; this only stops it crashing the process.
    });

    child.stdin?.write(
      JSON.stringify(jsonRpcRequest(1, "initialize", INITIALIZE_PARAMS)) + "\n",
    );
  });
}

/* -------------------------------------------------------------------------
 * http transport
 * ---------------------------------------------------------------------- */

/**
 * Pulls JSON-RPC messages out of a response body.
 *
 * MCP over HTTP answers in one of two shapes, and a server may pick either
 * per request: a plain JSON document, or a `text/event-stream` where the
 * payload sits on `data:` lines. Reading only the first shape is why these
 * servers previously failed with `Unexpected token 'e', "event: mes"...`.
 */
function parseJsonRpc(body: string): JsonRpcMessage[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Not a plain JSON document, so treat it as an event stream.
  }

  const messages: JsonRpcMessage[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload.startsWith("{") && !payload.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      // A partial frame is not fatal; a later one usually carries the reply.
    }
  }
  return messages;
}

function describeHttpStatus(status: number, body: string): string {
  const detail = body.trim().slice(0, 200);
  if (status === 401 || status === 403) {
    return `The server rejected the request (HTTP ${status}). It likely needs authentication.${detail ? ` ${detail}` : ""}`;
  }
  return `The server responded with HTTP ${status}.${detail ? ` ${detail}` : ""}`;
}

function authHeaders(
  accessToken: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...jsonHeaders(),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    // Explicit server headers (e.g. a hand-configured API key) win over an
    // auto-attached OAuth token — a user who configured their own auth
    // clearly intends to use it.
    ...(extra ?? {}),
  };
}

async function loadHttpTools(
  server: string,
  config: HttpServerConfig,
  accessToken?: string,
): Promise<ToolLoadResult> {
  const ca = await getSystemCertificates();
  const baseHeaders = authHeaders(accessToken, config.headers);
  const deadline = Date.now() + ABSOLUTE_TIMEOUT_MS;

  try {
    const init = await httpRequestFollowingRedirects(
      config.url,
      "POST",
      baseHeaders,
      JSON.stringify(jsonRpcRequest(1, "initialize", INITIALIZE_PARAMS)),
      ca,
      REQUEST_TIMEOUT_MS,
    );
    if (init.status === 401 || init.status === 403) {
      return authFailure(server, init);
    }
    if (init.status >= 400) {
      return failure(server, describeHttpStatus(init.status, init.body));
    }

    const initMessages = parseJsonRpc(init.body);
    const initError = initMessages.find((m) => m.error)?.error;
    if (initError) {
      return failure(server, initError.message ?? "initialize failed");
    }
    const initResult = initMessages.find((m) => m.id === 1)?.result;
    const negotiatedProtocolVersion = protocolVersionOf(initResult);

    // Streamable HTTP assigns a session on `initialize` and expects it back
    // on every later call. Dropping it makes a stateful server answer
    // `tools/list` with an error instead of its inventory.
    const sessionId = init.headers["mcp-session-id"];
    const headers: Record<string, string> = {
      ...baseHeaders,
      ...(typeof sessionId === "string" ? { "Mcp-Session-Id": sessionId } : {}),
      // Required on every request after `initialize` once a version was
      // negotiated, so the server knows which wire format to keep using.
      ...(negotiatedProtocolVersion
        ? { "MCP-Protocol-Version": negotiatedProtocolVersion }
        : {}),
    };

    // Required by the protocol before any regular request. Its reply is
    // typically an empty `202`, so nothing here needs the response.
    await httpRequestFollowingRedirects(
      config.url,
      "POST",
      headers,
      JSON.stringify(jsonRpcNotification("notifications/initialized")),
      ca,
      REQUEST_TIMEOUT_MS,
    ).catch(() => undefined);

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let nextId = 2;

    while (true) {
      if (Date.now() > deadline) {
        return failure(
          server,
          `Timed out after ${ABSOLUTE_TIMEOUT_MS}ms reading a paginated tools list.`,
        );
      }

      const listed = await httpRequestFollowingRedirects(
        config.url,
        "POST",
        headers,
        JSON.stringify(
          jsonRpcRequest(
            nextId,
            "tools/list",
            cursor ? { cursor } : undefined,
          ),
        ),
        ca,
        REQUEST_TIMEOUT_MS,
      );
      if (listed.status === 401 || listed.status === 403) {
        return authFailure(server, listed);
      }
      if (listed.status >= 400) {
        return failure(server, describeHttpStatus(listed.status, listed.body));
      }

      const messages = parseJsonRpc(listed.body);
      const reply =
        messages.find((m) => m.id === nextId) ??
        messages.find((m) => m.result || m.error);
      if (!reply) {
        return failure(
          server,
          "The server did not return a usable tools list.",
        );
      }
      if (reply.error) {
        return failure(server, reply.error.message ?? "tools/list failed");
      }

      tools.push(...toTools(reply.result));
      pages += 1;
      cursor = nextCursorOf(reply.result);
      nextId += 1;
      if (!cursor || pages >= MAX_TOOL_PAGES) break;
    }

    return {
      server,
      tools,
      ok: true,
      at: new Date().toISOString(),
      protocolVersion: negotiatedProtocolVersion,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (isUntrustedCertificateError(code)) {
      return failure(
        server,
        `Could not verify this server's TLS certificate (${code}). It is signed by an authority your system trusts but Node does not recognise.`,
      );
    }
    return failure(server, err instanceof Error ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------
 * legacy HTTP+SSE transport (`type: "sse"`)
 *
 * Distinct from streamable HTTP's optional SSE response body (handled by
 * `parseJsonRpc` above): this is the older two-channel transport where a
 * GET opens a long-lived event stream, the server's first frame on it names
 * a separate POST endpoint, and every JSON-RPC reply — including the one to
 * that very POST — arrives back over the GET stream, not in the POST's own
 * response body.
 * ---------------------------------------------------------------------- */

interface SseFrame {
  event?: string;
  data: string;
}

/** Splits a growing buffer into complete `\n\n`-terminated SSE frames, keeping any trailing partial frame. */
function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let sepIndex: number;
  while ((sepIndex = rest.indexOf("\n\n")) !== -1) {
    const raw = rest.slice(0, sepIndex);
    rest = rest.slice(sepIndex + 2);
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (event || dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

async function loadSseTools(
  server: string,
  config: HttpServerConfig,
  accessToken?: string,
): Promise<ToolLoadResult> {
  const ca = await getSystemCertificates();
  const streamHeaders: Record<string, string> = {
    Accept: "text/event-stream",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(config.headers ?? {}),
  };
  const postHeaders = authHeaders(accessToken, config.headers);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let endpointUrl: string | null = null;
    let exchangeStarted = false;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();

    const finish = (result: ToolLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      handle.close();
      resolve(result);
    };

    let idleTimer: NodeJS.Timeout;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(
          failure(
            server,
            `Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for the server's event stream.`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
    };
    resetIdleTimer();

    const absoluteTimer = setTimeout(() => {
      finish(
        failure(
          server,
          `Timed out after ${ABSOLUTE_TIMEOUT_MS}ms waiting for the server to finish responding.`,
        ),
      );
    }, ABSOLUTE_TIMEOUT_MS);

    /** Posts one JSON-RPC message to the endpoint the stream gave us, and waits for its reply on that same stream. */
    async function callAndWait(id: number, body: unknown): Promise<JsonRpcMessage> {
      const postReply = await httpRequestFollowingRedirects(
        endpointUrl!,
        "POST",
        postHeaders,
        JSON.stringify(body),
        ca,
        REQUEST_TIMEOUT_MS,
      );
      if (postReply.status === 401 || postReply.status === 403) {
        throw Object.assign(new Error("auth"), { authReply: postReply });
      }
      if (postReply.status >= 400) {
        throw new Error(describeHttpStatus(postReply.status, postReply.body));
      }
      // A handful of servers answer directly in the POST body rather than
      // (or as well as) over the stream; prefer that if present.
      const direct = parseJsonRpc(postReply.body).find((m) => m.id === id);
      if (direct) return direct;
      return new Promise((res) => pending.set(id, res));
    }

    async function runExchange() {
      if (exchangeStarted) return;
      exchangeStarted = true;
      try {
        const initReply = await callAndWait(
          1,
          jsonRpcRequest(1, "initialize", INITIALIZE_PARAMS),
        );
        if (initReply.error) {
          finish(failure(server, initReply.error.message ?? "initialize failed"));
          return;
        }
        const negotiatedProtocolVersion = protocolVersionOf(initReply.result);

        await callAndWait(
          -1,
          jsonRpcNotification("notifications/initialized"),
        ).catch(() => undefined);

        const tools: McpTool[] = [];
        let cursor: string | undefined;
        let pages = 0;
        let nextId = 2;

        while (true) {
          const reply = await callAndWait(
            nextId,
            jsonRpcRequest(
              nextId,
              "tools/list",
              cursor ? { cursor } : undefined,
            ),
          );
          if (reply.error) {
            finish(failure(server, reply.error.message ?? "tools/list failed"));
            return;
          }
          tools.push(...toTools(reply.result));
          pages += 1;
          cursor = nextCursorOf(reply.result);
          nextId += 1;
          if (!cursor || pages >= MAX_TOOL_PAGES) break;
        }

        finish({
          server,
          tools,
          ok: true,
          at: new Date().toISOString(),
          protocolVersion: negotiatedProtocolVersion,
        });
      } catch (err) {
        const authReply = (err as { authReply?: HttpReply } | undefined)
          ?.authReply;
        if (authReply) {
          finish(authFailure(server, authReply));
          return;
        }
        finish(failure(server, err instanceof Error ? err.message : String(err)));
      }
    }

    const handle = openSseGet(
      config.url,
      streamHeaders,
      ca,
      (chunk) => {
        resetIdleTimer();
        buffer += chunk;
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.event === "endpoint" && !endpointUrl) {
            endpointUrl = new URL(frame.data.trim(), config.url).toString();
            void runExchange();
          } else if (!frame.event || frame.event === "message") {
            let msg: JsonRpcMessage;
            try {
              msg = JSON.parse(frame.data);
            } catch {
              continue;
            }
            if (typeof msg.id === "number") {
              const waiter = pending.get(msg.id);
              if (waiter) {
                pending.delete(msg.id);
                waiter(msg);
              }
            }
          }
        }
      },
      (err) => {
        finish(failure(server, err.message));
      },
    );
  });
}

/* ---------------------------------------------------------------------- */

function isStdioConfig(config: McpServerConfig): config is StdioServerConfig {
  return config.type === "stdio" || config.type === "local";
}

/**
 * Asks one MCP server for its real tool inventory. Never throws.
 *
 * `accessToken` is an OAuth bearer token obtained through the sign-in flow
 * in `core/mcp-oauth.ts` (see `POST /api/tools`, which looks it up and
 * refreshes it before calling this). It only applies to HTTP/SSE servers —
 * a stdio server's credentials, if any, live in its own `env` block.
 */
export async function loadServerTools(
  server: string,
  config: McpServerConfig,
  accessToken?: string,
): Promise<ToolLoadResult> {
  if (isStdioConfig(config)) return loadStdioTools(server, config);
  if (config.type === "sse") return loadSseTools(server, config, accessToken);
  return loadHttpTools(server, config, accessToken);
}
