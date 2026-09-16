import { NextRequest, NextResponse } from "next/server";
import {
  clearManualOAuthClient,
  clearOAuthRecord,
  setManualOAuthClient,
} from "@/core/state";
import { invalidateSourceGraphCache } from "@/core/graph-cache";

/**
 * PUT /api/mcp-oauth/client — stores OAuth client credentials the user
 * registered with a provider by hand.
 *
 * The escape hatch for providers that do not hand out clients
 * automatically. Anything the user registers themselves names *their* app
 * on the consent screen, which is the tidiest outcome available when
 * dynamic registration is not on offer.
 *
 * Body: `{ key, clientId, clientSecret?, redirectUri? }`. Omitting
 * `redirectUri` means the client was registered against this app's own
 * callback, which is what the UI tells people to do.
 */
export async function PUT(request: NextRequest) {
  let body: {
    key?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!body.key || !body.clientId?.trim()) {
    return NextResponse.json(
      { error: "key and clientId are required" },
      { status: 400 },
    );
  }

  await setManualOAuthClient(body.key, {
    clientId: body.clientId.trim(),
    clientSecret: body.clientSecret?.trim() || undefined,
    redirectUri: body.redirectUri?.trim() || undefined,
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/mcp-oauth/client?key=<mcp nodeKey> — signs out of a server.
 *
 * Clears the tokens and the client registration, so the next sign-in
 * starts from scratch. `all=true` also forgets hand-entered credentials;
 * by default they are kept, since re-typing a client id and secret from a
 * developer console just to retry a sign-in would be tedious.
 */
export async function DELETE(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }
  await clearOAuthRecord(key);
  if (request.nextUrl.searchParams.get("all") === "true") {
    await clearManualOAuthClient(key);
  }
  // The stored inventory was read with a token that no longer applies.
  invalidateSourceGraphCache();
  return NextResponse.json({ ok: true });
}
