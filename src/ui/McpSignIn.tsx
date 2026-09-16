"use client";

import { useState } from "react";
import { Button } from "./Button";
import type { OAuthClientSource, ToolLoadResult } from "@/core/types";

/** What `/api/mcp-oauth/start` answers with, in either outcome. */
interface StartReply {
  authorizeUrl?: string;
  clientSource?: OAuthClientSource;
  error?: string;
  needsManualClient?: boolean;
  redirectUri?: string;
  authorizationServerUrl?: string;
}

const SOURCE_NOTE: Record<OAuthClientSource, string> = {
  dcr: "Signed in with an OAuth client this app registered for itself.",
  "cli-import":
    "This provider no longer issues new OAuth clients, so the app reused the one the Copilot CLI already registered on this machine. The consent screen will show the CLI's name rather than this app's. You still sign in yourself, and your CLI credentials are not read.",
  manual: "Signed in with the OAuth client credentials you provided.",
};

const panel: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface-subtle)",
  borderRadius: "var(--radius-md)",
  padding: "12px 14px",
  marginBottom: 12,
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 4,
};

const field: React.CSSProperties = {
  width: "100%",
  height: "var(--control-height)",
  padding: "0 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-strong)",
  fontSize: "var(--font-size-md)",
  background: "var(--surface)",
  color: "var(--text)",
};

/**
 * The sign-in panel for an MCP server that answered `tools/list` with 401.
 *
 * Sign-in happens in the provider's own window, which this opens as a
 * popup. Two things routinely go wrong and are handled here rather than
 * left to fail silently: the browser can block the popup, and the provider
 * may not issue OAuth clients automatically, in which case the user has to
 * register one and paste its credentials.
 */
export function McpSignIn({
  serverKey,
  result,
  busy,
  onSignedIn,
}: {
  serverKey: string;
  result: ToolLoadResult;
  /** True while the tool list is being re-read, so buttons cannot stack up. */
  busy: boolean;
  onSignedIn: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [manual, setManual] = useState<{
    redirectUri: string;
    authorizationServerUrl?: string;
  } | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [starting, setStarting] = useState(false);
  const [source, setSource] = useState<OAuthClientSource | null>(null);

  const signedIn = result.ok || !result.needsAuth;

  async function start() {
    setStarting(true);
    setError(null);
    setPendingUrl(null);
    try {
      const res = await fetch("/api/mcp-oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: serverKey }),
      });
      const data: StartReply = await res.json();

      if (data.needsManualClient) {
        setManual({
          redirectUri: data.redirectUri ?? "",
          authorizationServerUrl: data.authorizationServerUrl,
        });
        setError(data.error ?? null);
        return;
      }
      if (!res.ok || !data.authorizeUrl) {
        throw new Error(data.error ?? "Could not start sign-in.");
      }

      setSource(data.clientSource ?? null);
      const popup = window.open(
        data.authorizeUrl,
        "mcp-oauth",
        "width=520,height=720",
      );
      if (!popup || popup.closed) {
        // Blocked. The URL is still valid, so offer it as a plain link —
        // a click straight from the user counts as a gesture and opens.
        setPendingUrl(data.authorizeUrl);
        setError(
          "Your browser blocked the sign-in window. Use the link below instead.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function saveManualClient() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp-oauth/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: serverKey,
          clientId,
          clientSecret: clientSecret || undefined,
        }),
      });
      if (!res.ok) {
        const data: StartReply = await res.json();
        throw new Error(data.error ?? "Could not save those credentials.");
      }
      setManual(null);
      setClientId("");
      setClientSecret("");
      await start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function signOut() {
    setError(null);
    await fetch(`/api/mcp-oauth/client?key=${encodeURIComponent(serverKey)}`, {
      method: "DELETE",
    });
    setSource(null);
    onSignedIn();
  }

  if (signedIn) {
    if (!source) return null;
    return (
      <div style={panel}>
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {SOURCE_NOTE[source]}
        </p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" style={panel}>
      <p
        style={{ margin: 0, fontWeight: 600, fontSize: "var(--font-size-md)" }}
      >
        Sign-in required
      </p>
      <p
        style={{
          margin: "3px 0 0",
          fontSize: "var(--font-size-sm)",
          color: "var(--text-secondary)",
        }}
      >
        This server will not list its tools until you authorize access. The
        provider&rsquo;s own sign-in window opens in a popup.
      </p>

      {error && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
            wordBreak: "break-word",
          }}
        >
          {error}
        </p>
      )}

      {pendingUrl && (
        <p style={{ margin: "8px 0 0", fontSize: "var(--font-size-sm)" }}>
          <a
            href={pendingUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--primary)" }}
          >
            Open the sign-in page
          </a>
        </p>
      )}

      {manual ? (
        <div style={{ marginTop: 12 }}>
          <p
            style={{
              margin: "0 0 8px",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            Register an OAuth app with this provider
            {manual.authorizationServerUrl
              ? ` (${new URL(manual.authorizationServerUrl).host})`
              : ""}
            , then paste its credentials here. Set its redirect URI to
            exactly:
          </p>
          <code
            style={{
              display: "block",
              padding: "8px 10px",
              marginBottom: 10,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--surface)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              wordBreak: "break-all",
            }}
          >
            {manual.redirectUri}
          </code>

          <div style={{ marginBottom: 8 }}>
            <label htmlFor="oauth-client-id" style={label}>
              Client ID
            </label>
            <input
              id="oauth-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              style={field}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="oauth-client-secret" style={label}>
              Client secret (leave blank for a public client)
            </label>
            <input
              id="oauth-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              style={field}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={starting || !clientId.trim()}
            onClick={() => void saveManualClient()}
          >
            Save and sign in
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            size="sm"
            disabled={starting || busy}
            onClick={() => void start()}
          >
            {starting ? "Opening…" : "Sign in"}
          </Button>
        </div>
      )}
    </div>
  );
}
