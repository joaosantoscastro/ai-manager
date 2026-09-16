import { NextRequest, NextResponse } from "next/server";
import { getPluginsList, updatePlugins } from "@/adapters/copilot/cli";
import { pluginSettingsKey } from "@/adapters/copilot";
import { invalidateSourceGraphCache } from "@/core/graph-cache";

/**
 * POST /api/plugins/update — `{ name?: string }`.
 *
 * Omit `name` to run `copilot plugin update --all`, otherwise one plugin.
 *
 * The name is matched against the installed plugin list before it reaches the
 * CLI. That is both a guard (nothing the browser sends becomes a raw argument)
 * and the point at which `<plugin>@<marketplace>` is resolved, since that is
 * the form `copilot plugin update` expects for marketplace plugins.
 */
export async function POST(request: NextRequest) {
  let name: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    if (body?.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.trim() === "") {
        return NextResponse.json(
          { error: "name must be a non-empty string, or be omitted" },
          { status: 400 },
        );
      }
      name = body.name.trim();
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let target: { all: true } | { name: string } = { all: true };

  if (name !== undefined) {
    const list = await getPluginsList();
    if (!list.ok) {
      return NextResponse.json({ error: list.error }, { status: 502 });
    }
    const entry = list.data.plugins.find(
      (p) => p.kind === "plugin" && p.name === name,
    );
    if (!entry) {
      return NextResponse.json(
        { error: `No installed plugin named "${name}".` },
        { status: 404 },
      );
    }
    target = { name: pluginSettingsKey(entry) ?? entry.name };
  }

  const result = await updatePlugins(target);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  invalidateSourceGraphCache();
  return NextResponse.json({ ok: true, output: result.data });
}
