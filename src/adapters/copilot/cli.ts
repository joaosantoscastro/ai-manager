/**
 * Thin wrapper around `copilot` CLI JSON commands.
 *
 * Each function returns `{ ok: true, data }` or `{ ok: false, error }` —
 * callers (the normalizer) are expected to turn failures into SourceGraph
 * warnings rather than throwing, since the CLI may be absent, an
 * incompatible version, or briefly busy.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mcpListOutputSchema,
  pluginsListOutputSchema,
  skillListOutputSchema,
  type McpServerEntry,
  type PluginsListEntry,
  type SkillListEntry,
} from "./schema";

const execFileAsync = promisify(execFile);

const CLI_BIN = process.env.COPILOT_CLI_BIN || "copilot";
const CLI_TIMEOUT_MS = 15_000;
/** Updates fetch from a marketplace or git remote, so they outlast a read command. */
const CLI_UPDATE_TIMEOUT_MS = 180_000;

export type CliResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Runs a `copilot ...` command and returns its combined stdout+stderr text.
 *
 * Deliberately avoids capturing stdout via a plain pipe: on macOS, Node
 * gives child processes a non-blocking pipe fd for stdout, and this CLI's
 * bundled binary drops the tail of large writes against that fd instead of
 * retrying (verified: both `execFile` and `execFileSync` truncated
 * `copilot skill list --json` at exactly 8174 of 10008 bytes, while
 * `copilot ... > file` under a shell never truncated). Routing through a
 * shell redirect to a real file sidesteps the non-blocking-pipe write
 * entirely.
 *
 * On a non-zero exit the captured text is returned as the error, because the
 * CLI explains itself there and the `execFile` message alone says only that
 * the command failed.
 */
async function runCliText(
  args: string[],
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<CliResult<string>> {
  const dir = await mkdtemp(join(tmpdir(), "ai-setup-manager-"));
  const outFile = join(dir, "out.txt");
  const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const shellCmd = `${CLI_BIN} ${quotedArgs} > '${outFile}' 2>&1`;
  try {
    await execFileAsync("/bin/sh", ["-c", shellCmd], { timeout: timeoutMs });
    return { ok: true, data: await readFile(outFile, "utf8") };
  } catch (err) {
    const captured = await readFile(outFile, "utf8").catch(() => "");
    const message =
      captured.trim() || (err instanceof Error ? err.message : String(err));
    return { ok: false, error: `copilot ${args.join(" ")}: ${message}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs a `copilot ... --json` command and parses its output as JSON. */
async function runCliJson(args: string[]): Promise<CliResult<unknown>> {
  const res = await runCliText(args);
  if (!res.ok) return res;
  try {
    return { ok: true, data: JSON.parse(res.data) };
  } catch {
    return {
      ok: false,
      error: `copilot ${args.join(" ")}: could not parse JSON output`,
    };
  }
}

export interface PluginsListResult {
  plugins: PluginsListEntry[];
}

/** `copilot plugins list --json` — plugins, mcp, skill, instruction across all scopes. */
export async function getPluginsList(): Promise<CliResult<PluginsListResult>> {
  const res = await runCliJson(["plugins", "list", "--json"]);
  if (!res.ok) return res;
  const parsed = pluginsListOutputSchema.safeParse(res.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: `copilot plugins list --json: unexpected shape (${parsed.error.issues[0]?.message ?? "schema mismatch"})`,
    };
  }
  return { ok: true, data: { plugins: parsed.data.plugins } };
}

export interface McpListResult {
  servers: Record<string, McpServerEntry>;
}

/** `copilot mcp list --json` — every configured MCP server, with its live tools[] filter. */
export async function getMcpList(): Promise<CliResult<McpListResult>> {
  const res = await runCliJson(["mcp", "list", "--json"]);
  if (!res.ok) return res;
  const parsed = mcpListOutputSchema.safeParse(res.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: `copilot mcp list --json: unexpected shape (${parsed.error.issues[0]?.message ?? "schema mismatch"})`,
    };
  }
  return { ok: true, data: { servers: parsed.data.mcpServers } };
}

/** `copilot skill list --json` — skills across user, plugin and repo scopes, with paths. */
export async function getSkillList(): Promise<CliResult<SkillListEntry[]>> {
  const res = await runCliJson(["skill", "list", "--json"]);
  if (!res.ok) return res;
  const parsed = skillListOutputSchema.safeParse(res.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: `copilot skill list --json: unexpected shape (${parsed.error.issues[0]?.message ?? "schema mismatch"})`,
    };
  }
  return { ok: true, data: parsed.data };
}

export type UpdatePluginsTarget = { all: true } | { name: string };

/**
 * `copilot plugin update --all` / `copilot plugin update <name>`.
 *
 * This is the one CLI call that writes rather than reads, so it is never
 * issued with a name the caller has not already matched against the
 * installed plugin list.
 */
export async function updatePlugins(
  target: UpdatePluginsTarget,
): Promise<CliResult<string>> {
  const args =
    "all" in target
      ? ["plugin", "update", "--all"]
      : ["plugin", "update", target.name];
  return runCliText(args, CLI_UPDATE_TIMEOUT_MS);
}

/** Resolves once, cheaply, whether the copilot CLI is reachable at all. */ export async function isCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync(CLI_BIN, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
