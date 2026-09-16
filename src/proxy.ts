/**
 * Request guard for every route the local server exposes.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`, so this
 * file has to be called `proxy.ts` and sit beside `app/`. That is an
 * unfortunate clash with the `src/proxy/` directory next to it, which is the
 * MCP proxy and is entirely unrelated. Nothing imports `@/proxy` bare, so the
 * two coexist, but they are different things.
 *
 * Why this exists
 * ---------------
 * The app runs a real HTTP server on loopback and renders it in Electron.
 * Loopback is not an access control: any page in any browser on this machine
 * can send requests to `127.0.0.1:3000`, and until this guard existed every
 * route answered them. The routes rewrite `~/.copilot`, restore snapshots,
 * run `copilot plugin update` and spawn MCP server processes, so a hostile
 * page could drive all of it.
 *
 * Two distinct attacks are covered:
 *
 *  - **Cross-site request forgery.** A `POST` with `Content-Type: text/plain`
 *    is a CORS "simple request", so the browser sends it with no preflight
 *    and the attacker does not need to read the response to cause the write.
 *    Browsers do always set `Origin` on a cross-origin request of this kind,
 *    so comparing it is sufficient.
 *
 *  - **DNS rebinding.** The attacker points a name they control at
 *    `127.0.0.1`, which makes the browser treat this server as same-origin
 *    and lets them read responses too. `Origin` looks legitimate in that
 *    case; the `Host` header is what gives it away, because it still carries
 *    the attacker's name.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Methods that change state, and so are worth an origin check. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Strips the port from a `Host`-style value and normalizes IPv6 brackets, so
 * `[::1]:3000`, `127.0.0.1:3000` and `localhost` all reduce to a bare
 * hostname.
 */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  // A bare IPv6 address has several colons; only a `host:port` pair has one.
  const colon = value.indexOf(":");
  if (colon === -1) return value;
  if (value.indexOf(":", colon + 1) !== -1) return value;
  return value.slice(0, colon);
}

function isLoopbackHostHeader(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader));
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(hostnameOf(url.host));
  } catch {
    // Includes the literal string "null", which is what a sandboxed or
    // opaque origin sends. Neither is this app.
    return false;
  }
}

function forbidden(reason: string): NextResponse {
  return NextResponse.json({ error: reason }, { status: 403 });
}

export function proxy(request: NextRequest): NextResponse {
  // Checked on every method. A rebinding attack reads with `GET` just as
  // happily as it writes with `POST`.
  if (!isLoopbackHostHeader(request.headers.get("host"))) {
    return forbidden("This server only answers requests addressed to loopback.");
  }

  if (!MUTATING_METHODS.has(request.method)) return NextResponse.next();

  // Present on every cross-origin request a browser makes, and on same-origin
  // non-`GET` requests too. Absent for non-browser callers such as `curl`,
  // which are not the threat here — they already have the user's shell.
  const origin = request.headers.get("origin");
  if (origin !== null && !isLoopbackOrigin(origin)) {
    return forbidden("Cross-origin requests are not accepted.");
  }

  // A second, independent signal from Chromium (so, from Electron). `none`
  // means a direct navigation rather than a site-initiated request.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return forbidden("Cross-site requests are not accepted.");
  }

  return NextResponse.next();
}

export const config = {
  // Everything except build assets, which carry no privilege and are served
  // on every page load.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
