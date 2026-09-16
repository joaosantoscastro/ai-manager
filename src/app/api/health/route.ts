/**
 * Identifies the server process to the desktop shell that started it.
 *
 * The shell waits for this route before showing the window. Polling the port
 * alone is not enough: a development server, or another copy of this app, can
 * already be answering on the same port, and the window would then render a
 * stranger's output. The instance token makes that impossible.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    instance: process.env.PLUGIN_MANAGER_INSTANCE ?? null,
  });
}
