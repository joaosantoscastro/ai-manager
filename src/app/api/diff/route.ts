import { NextRequest, NextResponse } from "next/server";
import { getSourceGraph } from "@/core/graph-cache";
import { planEmit } from "@/core/emit";
import { parseOverrideMap, type OverrideMap } from "@/core/types";
import { parseUploadList, type PendingUpload } from "@/core/uploads";

export const dynamic = "force-dynamic";

/**
 * POST /api/diff — { overrides, uploads } → preview what `/api/apply` would change,
 * without writing anything.
 *
 * Pending decisions live in the browser's state service, so they arrive in
 * the request body rather than being read from disk. The browser already
 * knows how many changes are pending (it derives that from the same
 * overrides), so this route is only called when the user actually opens the
 * apply dialog — never on every click.
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

  const source = await getSourceGraph();
  const plan = await planEmit(source, overrides, uploads);
  return NextResponse.json({
    changes: plan.changes,
    skipped: plan.skipped,
    settingsChanged: plan.settingsChanged,
    mcpConfigChanged: plan.mcpConfigChanged,
    // Paths, not content: disabling a plugin hook edits a file outside
    // `~/.copilot`, so the user needs to see exactly which one.
    hookFiles: Object.keys(plan.hookFiles),
  });
}
