import { NextResponse } from "next/server";
import { getSourceGraph, invalidateSourceGraphCache } from "@/core/graph-cache";

/** POST /api/graph/refresh — force a fresh discovery pass, bypassing the TTL cache. */
export async function POST() {
  invalidateSourceGraphCache();
  const graph = await getSourceGraph({ force: true });
  return NextResponse.json({
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    warnings: graph.warnings,
  });
}
