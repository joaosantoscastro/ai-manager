import { NextRequest, NextResponse } from "next/server";
import { listSnapshots, restoreSnapshot } from "@/core/snapshot";
import { invalidateSourceGraphCache } from "@/core/graph-cache";

/** GET /api/revert — list available snapshots (most recent first). */
export async function GET() {
  const snapshots = await listSnapshots();
  return NextResponse.json({ snapshots });
}

/** POST /api/revert — { snapshotId } → restores ~/.copilot files to that point. */
export async function POST(request: NextRequest) {
  let body: { snapshotId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.snapshotId) {
    return NextResponse.json(
      { error: "snapshotId is required" },
      { status: 400 },
    );
  }

  try {
    const result = await restoreSnapshot(body.snapshotId);
    invalidateSourceGraphCache();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
