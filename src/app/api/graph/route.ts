import { NextResponse } from "next/server";
import { getSourceGraph } from "@/core/graph-cache";
import { mergeGraph } from "@/core/graph";

export const dynamic = "force-dynamic";

/**
 * GET /api/graph — the whole discovered setup, resolved as it stands on
 * disk (no pending overrides applied).
 *
 * Deliberately unfiltered. The browser fetches this once for the entire
 * app and filters by kind/scope locally, because resolving a node's
 * effective state needs its parent: filtering server-side would strip the
 * plugin a tool hangs off and break the cascade the moment the user makes
 * a pending change.
 */
export async function GET() {
  const source = await getSourceGraph();
  const resolved = mergeGraph(source, {});

  return NextResponse.json({
    nodes: resolved.nodes,
    generatedAt: resolved.generatedAt,
    warnings: resolved.warnings,
  });
}
