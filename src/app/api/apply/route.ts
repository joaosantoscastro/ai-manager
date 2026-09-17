import { NextRequest, NextResponse } from "next/server";
import { applyEmit } from "@/core/emit";
import { invalidateSourceGraphCache } from "@/core/graph-cache";
import { parseOverrideMap, type OverrideMap } from "@/core/types";
import { parseUploadList, type PendingUpload } from "@/core/uploads";

/**
 * POST /api/apply — { overrides, uploads } → writes the browser's pending decisions
 * into `~/.copilot/settings.json` / `mcp-config.json` (and any plugin
 * `.mcp.json` needing the proxy fallback), snapshotting them all first.
 *
 * This is the only point at which a user's clicks reach the filesystem.
 */
export async function POST(request: NextRequest) {
  let overrides: OverrideMap | null;
  let uploads: PendingUpload[] | null;
  try {
    const body = (await request.json()) as {
      overrides?: unknown;
      uploads?: unknown;
    };
    overrides = parseOverrideMap(body?.overrides);
    uploads = parseUploadList(body?.uploads);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!overrides) {
    return NextResponse.json(
      { error: "overrides must map a node key to { enabled: boolean }" },
      { status: 400 },
    );
  }
  if (!uploads) {
    return NextResponse.json(
      { error: "uploads must be a list of { id, kind, name, files, replace }" },
      { status: 400 },
    );
  }

  try {
    const result = await applyEmit(overrides, uploads);
    invalidateSourceGraphCache();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
