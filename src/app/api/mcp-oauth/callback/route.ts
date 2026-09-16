import { NextRequest } from "next/server";
import { takePendingOAuth, setOAuthRecord } from "@/core/state";
import { exchangeCodeForToken } from "@/core/mcp-oauth";

/**
 * Escapes text for an HTML text node. `error` and `error_description` arrive
 * as query parameters, so anything unescaped here is a reflected XSS on the
 * app's own origin — and script on that origin can drive every API route.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializes a value for embedding inside a `<script>` block.
 *
 * `JSON.stringify` alone is not safe here: it leaves `<` untouched, so a
 * string containing `</script>` closes the block and everything after it is
 * parsed as markup. Escaping `<` as `\u003c` keeps the JSON equivalent while
 * making that impossible. U+2028 and U+2029 are escaped too, since both are
 * valid JSON but are line terminators in a script body.
 */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * A tiny standalone HTML page: this response is what the OAuth redirect
 * lands the popup window on, not a page the app's own React tree ever
 * renders, so it has to fend for itself. It tells the opener whether
 * sign-in worked and then closes itself; `McpToolsTab` listens for the
 * `postMessage` to know when to reload the server's tools.
 */
function popupPage(message: {
  ok: boolean;
  serverKey?: string;
  error?: string;
}): string {
  const payload = toScriptJson({ source: "mcp-oauth", ...message });
  const text = message.ok
    ? "Signed in. You can close this window."
    : `Sign-in failed: ${message.error ?? "unknown error"}`;
  return `<!doctype html>
<html>
<body style="font: 14px system-ui; padding: 2rem; color: #222;">
<p>${escapeHtml(text)}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${payload}, window.location.origin);
  }
  window.close();
</script>
</body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /api/mcp-oauth/callback — where the authorization server redirects
 * the browser back to after the user approves (or denies) access.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const error = params.get("error");
  const stateParam = params.get("state");
  const code = params.get("code");

  if (error) {
    return htmlResponse(
      popupPage({
        ok: false,
        error: params.get("error_description") ?? error,
      }),
    );
  }
  if (!stateParam || !code) {
    return htmlResponse(
      popupPage({ ok: false, error: "Missing code or state in redirect." }),
    );
  }

  const pending = await takePendingOAuth(stateParam);
  if (!pending) {
    return htmlResponse(
      popupPage({
        ok: false,
        error: "This sign-in attempt expired or was already used.",
      }),
    );
  }

  const tokens = await exchangeCodeForToken({
    tokenEndpoint: pending.tokenEndpoint,
    code,
    redirectUri: pending.redirectUri,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    codeVerifier: pending.codeVerifier,
    resource: pending.resourceUrl,
  });
  if (!tokens) {
    return htmlResponse(
      popupPage({
        ok: false,
        serverKey: pending.serverKey,
        error: "The authorization server did not return a valid token.",
      }),
    );
  }

  await setOAuthRecord(pending.serverKey, {
    serverUrl: pending.serverUrl,
    authorizationServerUrl: pending.authorizationServerUrl,
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    clientSource: pending.clientSource,
    redirectUri: pending.redirectUri,
    resourceUrl: pending.resourceUrl,
    scope: pending.scope,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    updatedAt: new Date().toISOString(),
  });

  return htmlResponse(popupPage({ ok: true, serverKey: pending.serverKey }));
}
