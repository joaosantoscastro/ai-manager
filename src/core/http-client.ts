/**
 * Small CA-aware HTTP client shared by `tool-loader.ts` (MCP JSON-RPC over
 * HTTP/SSE) and `mcp-oauth.ts` (OAuth discovery, registration, token
 * exchange).
 *
 * Deliberately `node:http`/`node:https` rather than the global `fetch`:
 * `fetch` cannot be given a custom certificate authority list, and without
 * one every internal host behind a corporate TLS proxy fails to verify
 * (see `system-ca.ts`). Centralized here so both callers get the same
 * redirect handling and CA behavior instead of two slightly different
 * copies.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";

export interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const MAX_REDIRECTS = 5;

/** Headers that authenticate the caller and must never cross an origin boundary. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Drops credential headers when a redirect leaves the origin that was asked
 * for them.
 *
 * `Authorization: Bearer …` is attached for MCP servers the user has signed
 * in to. Following a redirect with that header still set hands the token to
 * whatever host the response names, so a compromised or hostile server could
 * harvest it with a single `302`.
 */
function headersForRedirect(
  headers: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  let sameOrigin: boolean;
  try {
    sameOrigin = new URL(from).origin === new URL(to).origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return headers;

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase()),
    ),
  );
}

/**
 * One HTTP request, following redirects itself.
 *
 * 307/308 preserve the method and body, exactly as sent. 301/302/303 are
 * followed as a GET with no body, matching how browsers (and most HTTP
 * clients) treat them — servers issuing those for a JSON-RPC POST are not
 * expected in practice, but a plain follow-forever loop is worse than a
 * pragmatic downgrade.
 */
export async function httpRequestFollowingRedirects(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  ca: string[],
  timeoutMs: number,
  redirectsLeft = MAX_REDIRECTS,
): Promise<HttpReply> {
  const reply = await httpRequestOnce(url, method, headers, body, ca, timeoutMs);
  const isRedirect = [301, 302, 303, 307, 308].includes(reply.status);
  if (!isRedirect || redirectsLeft <= 0) return reply;

  const location = reply.headers.location;
  if (!location || typeof location !== "string") return reply;

  const nextUrl = new URL(location, url).toString();
  const preserveBody = reply.status === 307 || reply.status === 308;
  return httpRequestFollowingRedirects(
    nextUrl,
    preserveBody ? method : "GET",
    headersForRedirect(headers, url, nextUrl),
    preserveBody ? body : undefined,
    ca,
    timeoutMs,
    redirectsLeft - 1,
  );
}

function httpRequestOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  ca: string[],
  timeoutMs: number,
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const secure = target.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;

    const req = send(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(body !== undefined
            ? { "Content-Length": Buffer.byteLength(body).toString() }
            : {}),
        },
        // Added to Node's bundled roots, never replacing them, so
        // verification stays on for public certificates too.
        ...(secure && ca.length > 0
          ? { ca: [...rootCertificates, ...ca] }
          : {}),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
          }),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`Timed out after ${timeoutMs}ms waiting for a response.`),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

export function jsonHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  };
}

export interface SseHandle {
  close: () => void;
}

/**
 * Opens a long-lived `GET` request and hands each raw chunk of the response
 * body to `onData` as it arrives, instead of buffering to `end` like
 * `httpRequestFollowingRedirects` — needed for the legacy MCP HTTP+SSE
 * transport, where the server never closes the connection and the tool
 * inventory arrives as a sequence of frames on it (see `tool-loader.ts`'s
 * `loadSseTools`). Redirects on the initial connect are not followed here:
 * SSE endpoints are not expected to redirect, and doing so mid-stream would
 * need to hand off the open connection, which none of our real servers
 * require.
 */
export function openSseGet(
  url: string,
  headers: Record<string, string>,
  ca: string[],
  onData: (chunk: string) => void,
  onError: (err: Error) => void,
): SseHandle {
  let target: URL;
  try {
    target = new URL(url);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return { close: () => {} };
  }

  const secure = target.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;

  const req = send(
    target,
    {
      method: "GET",
      headers,
      ...(secure && ca.length > 0 ? { ca: [...rootCertificates, ...ca] } : {}),
    },
    (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        onError(
          new Error(
            `The server responded with HTTP ${res.statusCode} opening the event stream.`,
          ),
        );
        req.destroy();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => onData(chunk));
      res.on("error", (err) => onError(err));
    },
  );

  req.on("error", (err) => onError(err));
  req.end();

  return { close: () => req.destroy() };
}
