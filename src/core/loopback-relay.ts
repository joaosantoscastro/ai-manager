/**
 * A one-shot loopback listener that forwards an OAuth redirect back into
 * the app.
 *
 * A `client_id` is bound to the redirect URIs it was registered with, and
 * the token endpoint validates that the `redirect_uri` sent at exchange
 * matches the one sent at authorize. So when a client comes from anywhere
 * other than this app's own dynamic registration — imported from the CLI,
 * or typed in by the user — the app has to receive the redirect at *that*
 * client's address, not at its own callback route.
 *
 * Native OAuth clients register loopback addresses (RFC 8252), so the
 * address is nearly always something this process can simply bind. This
 * binds whatever host, port and path the client specifies, redirects the
 * browser on to the app's real callback route with the query string
 * intact, and shuts down. Nothing here is specific to any provider.
 */
import { createServer, type Server } from "node:http";

/**
 * How long a listener waits before giving up. A user who opens the auth
 * window and wanders off must not leave a port bound forever.
 */
const RELAY_TTL_MS = 10 * 60 * 1000;

/** Loopback per RFC 8252 §7.3, plus the hostname form people actually type. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  );
}

const active = new Map<string, Server>();

function relayKey(hostname: string, port: number): string {
  return `${hostname}:${port}`;
}

export class LoopbackRelayError extends Error {}

/**
 * Starts a listener for `redirectUri` that forwards to
 * `${appOrigin}/api/mcp-oauth/callback`.
 *
 * Returns without doing anything when the redirect URI already points at
 * the app itself, which is the case for clients this app registered.
 *
 * Throws `LoopbackRelayError` with a message meant to be shown to the
 * user: a busy port or a non-loopback address are both things only they
 * can resolve, and both are far less confusing caught here than as an
 * opaque failure after they have already logged in.
 */
export async function startLoopbackRelay(
  redirectUri: string,
  appOrigin: string,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    throw new LoopbackRelayError(
      `The OAuth client's redirect URI is not a valid URL: ${redirectUri}`,
    );
  }

  // Already ours — the callback route receives the redirect directly.
  if (target.origin === new URL(appOrigin).origin) return;

  if (!isLoopbackHost(target.hostname)) {
    throw new LoopbackRelayError(
      `This OAuth client redirects to ${target.origin}, which this app cannot receive. ` +
        `Register the client against ${appOrigin}/api/mcp-oauth/callback instead.`,
    );
  }

  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const key = relayKey(target.hostname, port);
  // A second sign-in attempt on the same address reuses the live listener
  // rather than failing on its own port.
  if (active.has(key)) return;

  const callbackBase = new URL("/api/mcp-oauth/callback", appOrigin);

  const server = createServer((req, res) => {
    const query = req.url?.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    res.writeHead(302, { Location: `${callbackBase.toString()}${query}` });
    res.end();
    close();
  });

  let ttlTimer: NodeJS.Timeout | undefined;
  function close() {
    if (ttlTimer) clearTimeout(ttlTimer);
    active.delete(key);
    server.close();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      active.delete(key);
      reject(
        new LoopbackRelayError(
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use, and this server's OAuth client requires it. ` +
              `Stop whatever is using it (often the Copilot CLI mid sign-in) and try again.`
            : `Could not listen on ${key}: ${err.message}`,
        ),
      );
    });
    server.listen(port, target.hostname, () => {
      active.set(key, server);
      ttlTimer = setTimeout(close, RELAY_TTL_MS);
      // Node keeps the event loop alive for a listening server; this one is
      // incidental to the request that started it.
      ttlTimer.unref?.();
      server.unref?.();
      resolve();
    });
  });
}
