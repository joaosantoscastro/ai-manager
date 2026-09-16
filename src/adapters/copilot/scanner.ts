/**
 * Filesystem scanner for entities the Copilot CLI's JSON commands do not
 * report: agents, hooks, plugin manifests, and the raw file listing that
 * composes a plugin. Skills are also re-derived here for cross-checking,
 * but `copilot skill list --json` remains the primary source for skills
 * (see adapters/copilot/index.ts).
 *
 * The CLI itself says as much: `copilot plugins list --help` states
 * "Custom agents and session-scoped hooks are not yet covered — both
 * require a live session and will be added in a follow-up." This module
 * fills that gap without hardcoding any specific plugin or marketplace.
 *
 * Hooks are read at the granularity of a single array entry, keeping each
 * one's event key and array index. Copilot has no per-hook enable setting,
 * so `core/emit.ts` switches a hook off by deleting its entry — and it can
 * only put that entry back in the right place if discovery recorded where
 * it came from.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import matter from "gray-matter";

export interface AgentFile {
  name: string;
  description?: string;
  filePath: string;
  raw: Record<string, unknown>;
}

/**
 * One raw entry from a `hooks.<event>[]` array, with everything needed to
 * find it again and put it back: the event key exactly as spelled in the
 * file, the entry's position in that array, and the untouched object.
 */
export interface RawHookEntry {
  /** Event key verbatim. Both `preToolUse` and `PreToolUse` occur in the wild. */
  event: string;
  /** Same event with a lowercased first character, used for grouping. */
  normalizedEvent: string;
  index: number;
  matcher?: string;
  /** The `bash`/`powershell`/`command` value, or "unknown" when absent. */
  command: string;
  timeoutSec?: number;
  entry: Record<string, unknown>;
}

/**
 * A logical hook: every raw entry that runs the same command on the same
 * event, across both spellings of that event's key.
 *
 * Plugins routinely declare a hook twice — once under `preToolUse` and once
 * under `PreToolUse` — with *different* matchers (`bash|shell|…` versus
 * `Bash|Shell`). Those are one hook to a user, so the matcher is deliberately
 * not part of the grouping key; only the event and the command are.
 */
export interface LogicalHook {
  /** `<normalizedEvent>::<command>` — stable across refreshes. */
  key: string;
  normalizedEvent: string;
  command: string;
  /** The first entry's matcher, for display. */
  matcher?: string;
  timeoutSec?: number;
  entries: RawHookEntry[];
}

export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  skills?: string | string[];
  mcpServers?: string;
  hooks?: string;
  raw: Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readAgentFile(filePath: string): Promise<AgentFile | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const name =
      typeof data.name === "string"
        ? data.name
        : basename(filePath).replace(/\.agent\.md$|\.md$/, "");
    return {
      name,
      description:
        typeof data.description === "string" ? data.description : undefined,
      filePath,
      raw: data,
    };
  } catch {
    return null;
  }
}

/** Scans a directory (non-recursive) for `*.agent.md` or `*.md` agent files. */
async function scanAgentDir(dir: string): Promise<AgentFile[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter(
    (e) =>
      e.isFile() && (e.name.endsWith(".agent.md") || e.name.endsWith(".md")),
  );
  const agents = await Promise.all(
    files.map((f) => readAgentFile(join(dir, f.name))),
  );
  return agents.filter((a): a is AgentFile => a !== null);
}

/** User-scope agents: `~/.copilot/agents/*.agent.md`. */
export async function scanUserAgents(): Promise<AgentFile[]> {
  return scanAgentDir(join(homedir(), ".copilot", "agents"));
}

/**
 * Plugin-scope agents. Handles both known layouts seen in the wild:
 *   - directly under `<pluginRoot>/agents/`
 *   - namespaced under `<pluginRoot>/com.github.copilot/agents/`
 *     (used by plugins installed from the awesome-copilot marketplace)
 */
export async function scanPluginAgents(
  pluginRoot: string,
): Promise<AgentFile[]> {
  const [direct, namespaced] = await Promise.all([
    scanAgentDir(join(pluginRoot, "agents")),
    scanAgentDir(join(pluginRoot, "com.github.copilot", "agents")),
  ]);
  return [...direct, ...namespaced];
}

/** Lowercases the first character, so `PreToolUse` and `preToolUse` agree. */
function normalizeEvent(event: string): string {
  return event.charAt(0).toLowerCase() + event.slice(1);
}

/** Reads an entry's command, preferring `bash` over `powershell` over `command`. */
function entryCommand(entry: Record<string, unknown>): string {
  for (const field of ["bash", "powershell", "command"]) {
    const value = entry[field];
    if (typeof value === "string" && value) return value;
  }
  return "unknown";
}

function toRawHookEntries(hooks: Record<string, unknown>): RawHookEntry[] {
  const results: RawHookEntry[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    list.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const entry = raw as Record<string, unknown>;
      results.push({
        event,
        normalizedEvent: normalizeEvent(event),
        index,
        matcher: typeof entry.matcher === "string" ? entry.matcher : undefined,
        command: entryCommand(entry),
        timeoutSec:
          typeof entry.timeoutSec === "number" ? entry.timeoutSec : undefined,
        entry,
      });
    });
  }
  return results;
}

/**
 * Reads a `hooks.json`-shaped file (`{ version, hooks: { <event>: [] } }`)
 * into raw, individually addressable entries.
 *
 * Returns `[]` both when the file is missing and when it is unreadable. The
 * caller cannot act on the difference — either way there is nothing to list
 * and nothing safe to rewrite.
 */
export async function scanHookFile(filePath: string): Promise<RawHookEntry[]> {
  if (!(await exists(filePath))) return [];
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return toRawHookEntries(raw.hooks ?? {});
  } catch {
    return [];
  }
}

/**
 * Resolves a plugin's hook file. `plugin.json` may point somewhere other
 * than the default via its `hooks` key, so that declaration wins.
 */
export function pluginHookFilePath(
  pluginRoot: string,
  declared: string | undefined,
): string {
  return join(pluginRoot, declared ?? "hooks.json");
}

/**
 * Reads user-scope hooks from `~/.copilot/settings.json`'s top-level `hooks`
 * key. Unlike a plugin's `hooks.json`, these share a file with every other
 * setting, so `core/emit.ts` must edit them through the settings object it
 * is already building rather than as a standalone file.
 */
export async function scanSettingsHooks(
  settingsPath: string,
): Promise<RawHookEntry[]> {
  if (!(await exists(settingsPath))) return [];
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    if (!raw.hooks || typeof raw.hooks !== "object") return [];
    return toRawHookEntries(raw.hooks);
  } catch {
    return [];
  }
}

/**
 * Reads the global `disableAllHooks` switch from settings.json. Absent or
 * unreadable both mean "hooks run", matching Copilot's own default.
 */
export async function readDisableAllHooks(
  settingsPath: string,
): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
      disableAllHooks?: unknown;
    };
    return raw.disableAllHooks === true;
  } catch {
    return false;
  }
}

/**
 * Folds raw entries into logical hooks keyed by `<normalizedEvent>::<command>`.
 *
 * Insertion order is preserved so the list reads in the order the file
 * declares things. Entries sharing a key join the same group even when their
 * matchers differ — that is the whole point, since the camelCase and
 * PascalCase spellings of one hook carry different matchers.
 */
export function groupHookEntries(raw: RawHookEntry[]): LogicalHook[] {
  const groups = new Map<string, LogicalHook>();
  for (const item of raw) {
    const key = `${item.normalizedEvent}::${item.command}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(item);
      continue;
    }
    groups.set(key, {
      key,
      normalizedEvent: item.normalizedEvent,
      command: item.command,
      matcher: item.matcher,
      timeoutSec: item.timeoutSec,
      entries: [item],
    });
  }
  return Array.from(groups.values());
}

/** Reads and parses a plugin's `plugin.json` manifest. */
export async function readPluginManifest(
  pluginRoot: string,
): Promise<PluginManifest | null> {
  const filePath = join(pluginRoot, "plugin.json");
  if (!(await exists(filePath))) return null;
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      name: typeof raw.name === "string" ? raw.name : basename(pluginRoot),
      description:
        typeof raw.description === "string" ? raw.description : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
      skills: raw.skills as string | string[] | undefined,
      mcpServers: raw.mcpServers as string | undefined,
      hooks: raw.hooks as string | undefined,
      raw,
    };
  } catch {
    return null;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);

/** Recursively lists every file under a plugin root, for the "files" detail panel. */
export async function listPluginFiles(
  pluginRoot: string,
  maxFiles = 500,
): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(pluginRoot);
  return results;
}

export interface RawMcpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  tools?: string[];
}

/**
 * Reads a plugin's own MCP config file directly (bypassing the CLI).
 * Used as a fallback for plugins the CLI does not enumerate — in
 * particular, disabled plugins: `copilot mcp list` only reports servers
 * belonging to *enabled* plugins, but the app still needs to show a
 * disabled plugin's components for navigation and re-enabling.
 */
export async function scanPluginMcpConfig(
  pluginRoot: string,
  relPath = ".mcp.json",
): Promise<Record<string, RawMcpServerConfig>> {
  const filePath = join(pluginRoot, relPath);
  if (!(await exists(filePath))) return {};
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      mcpServers?: Record<string, RawMcpServerConfig>;
    };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

export interface RawSkill {
  name: string;
  description?: string;
  path: string;
}

/**
 * Reads skill directories declared by a plugin's manifest directly
 * (bypassing the CLI), for the same reason as `scanPluginMcpConfig`:
 * disabled plugins' skills are invisible to `copilot skill list`.
 * `skillGlobs` are the plugin.json `skills` entries, e.g. `["skills/"]`.
 */
export async function scanPluginSkills(
  pluginRoot: string,
  skillGlobs: string | string[] | undefined,
): Promise<RawSkill[]> {
  const globs = !skillGlobs ? ["skills/"] : ([] as string[]).concat(skillGlobs);
  const results: RawSkill[] = [];
  for (const glob of globs) {
    const dir = join(pluginRoot, glob.replace(/\/$/, ""));
    if (!(await exists(dir))) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (!(await exists(skillMd))) continue;
      try {
        const raw = await readFile(skillMd, "utf8");
        const parsed = matter(raw);
        const data = parsed.data as Record<string, unknown>;
        results.push({
          name: typeof data.name === "string" ? data.name : entry.name,
          description:
            typeof data.description === "string" ? data.description : undefined,
          path: join(dir, entry.name),
        });
      } catch {
        // skip unreadable skill
      }
    }
  }
  return results;
}

/**
 * Given a skill's absolute path (as returned by `copilot skill list --json`,
 * e.g. `<pluginRoot>/skills/<skillName>`), derives the plugin root under the
 * standard plugin layout declared by `plugin.json`'s `"skills": ["skills/"]`.
 * Best-effort: returns undefined if the path doesn't match that shape.
 */
export function derivePluginRootFromSkillPath(
  skillPath: string,
): string | undefined {
  const parent = dirname(skillPath);
  if (basename(parent) !== "skills") return undefined;
  return dirname(parent);
}
