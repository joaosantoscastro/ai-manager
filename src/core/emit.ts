/**
 * Turns the current managed-state overrides into real changes to the
 * Copilot config on disk (`~/.copilot/settings.json` for plugin/mcp/skill
 * toggles, `~/.copilot/mcp-config.json` for direct tool-filter edits on
 * user-scope servers, and — as a last-resort fallback — a plugin's own
 * `.mcp.json` when its tools need filtering and there's no user-scope
 * override point that reliably wins over the plugin's declaration; see
 * `src/proxy`). This is the only module allowed to touch those files, and
 * it always snapshots them first via `core/snapshot.ts` so an apply can be
 * undone from the UI.
 *
 * Per the approved plan, this never uses `COPILOT_HOME` — it writes the
 * user's real config directly, because that's what both the CLI and the
 * desktop app read.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSourceGraph } from "@/adapters/copilot";
import {
  getPackagedNodeRuntime,
  getPackagedProxyBin,
  getSourceProxyBin,
  isPackaged,
} from "./app-paths";
import { createSnapshot } from "./snapshot";
import {
  readManagedState,
  setProxiedServerOriginal,
  clearProxiedServerOriginal,
  setDisabledHook,
  clearDisabledHook,
} from "./state";
import type {
  DisabledHookEntry,
  DisabledHookRecord,
  ManagedState,
  OverrideMap,
  SourceGraph,
  SourceNode,
} from "./types";
import { nodeKey } from "./types";

export const SETTINGS_PATH = join(homedir(), ".copilot", "settings.json");
export const MCP_CONFIG_PATH = join(homedir(), ".copilot", "mcp-config.json");

/** Marks a proxied entry so a later apply recognizes it instead of re-wrapping it. */
const PROXY_MARKER = "_aiSetupManagerProxy";

/**
 * The launcher Copilot writes into its own config and spawns later, possibly
 * long after this app has quit. It therefore has to name a runtime and a
 * script path that survive on their own.
 *
 * The packaged app points at its own Electron binary, which runs plain Node
 * scripts under `ELECTRON_RUN_AS_NODE=1`, and at a precompiled proxy shipped
 * in its resources. A repo checkout has neither, so it keeps running the
 * TypeScript entry point through `npx tsx`.
 */
function buildProxyLauncher(
  original: unknown,
  allowed: string[],
): Record<string, unknown> {
  const proxyArgs = [
    "--upstream",
    JSON.stringify(original),
    "--allow",
    allowed.join(","),
  ];

  const runtime = getPackagedNodeRuntime();
  if (isPackaged() && runtime) {
    return {
      type: "stdio",
      command: runtime,
      args: [getPackagedProxyBin(), ...proxyArgs],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      [PROXY_MARKER]: true,
    };
  }

  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "tsx", getSourceProxyBin(), ...proxyArgs],
    [PROXY_MARKER]: true,
  };
}

interface SettingsShape {
  enabledPlugins?: Record<string, boolean>;
  disabledMcpServers?: string[];
  disabledSkills?: string[];
  disableAllHooks?: boolean;
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

interface McpConfigShape {
  mcpServers?: Record<string, { tools?: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Both `settings.json` and a plugin's `hooks.json` expose hooks this way. */
interface HookFileShape {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

/** What `adapters/copilot` puts in `SourceNode.raw` for a hook node. */
interface HookNodeRaw {
  event: string;
  command: string;
  matcher?: string;
  timeoutSec?: number;
  entries: DisabledHookEntry[];
}

export interface EmitChange {
  file: string;
  description: string;
}

/**
 * Skip reason used when an override points at a node that discovery no longer
 * finds. These are the only overrides that are safe to prune automatically,
 * so the prune route matches on this exact string.
 */
export const ORPHANED_OVERRIDE_REASON =
  "Node no longer exists in the discovered setup.";

export interface EmitSkip {
  nodeKey: string;
  reason: string;
}

export interface EmitPlan {
  settings: SettingsShape;
  mcpConfig: McpConfigShape;
  settingsChanged: boolean;
  mcpConfigChanged: boolean;
  /** Plugin `.mcp.json` files rewritten to route through the proxy, path -> new full file content. */
  pluginFiles: Record<string, unknown>;
  /** Plugin hook files with entries spliced out or put back, path -> new full file content. */
  hookFiles: Record<string, unknown>;
  changes: EmitChange[];
  skipped: EmitSkip[];
  /**
   * `proxiedServers` bookkeeping this plan implies, to be committed only by
   * `applyEmit`. Planning must stay side-effect free: `/api/diff` is a
   * read-only preview, and stashing an original during a dry run makes the
   * server look permanently proxied, so its change can never clear.
   */
  proxyStateUpdates: ProxyStateUpdate[];
  /**
   * `disabledHooks` bookkeeping, committed only by `applyEmit` for the same
   * reason. Stashing during a `/api/diff` preview would mark a hook disabled
   * while its entries are still in the file, and discovery would then hide
   * the stash behind the live entries forever.
   */
  hookStateUpdates: HookStateUpdate[];
}

export type ProxyStateUpdate =
  | { mcpKey: string; action: "stash"; original: Record<string, unknown> }
  | { mcpKey: string; action: "clear" };

export type HookStateUpdate =
  | { hookKey: string; action: "stash"; record: DisabledHookRecord }
  | { hookKey: string; action: "clear" };

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function setAdd(arr: string[] | undefined, value: string): string[] {
  const set = new Set(arr ?? []);
  set.add(value);
  return Array.from(set);
}

function setRemove(arr: string[] | undefined, value: string): string[] {
  return (arr ?? []).filter((v) => v !== value);
}

/**
 * Computes the settings/mcp-config patches implied by `overrides`, without
 * writing anything. Used by both `/api/diff` (preview) and `/api/apply`
 * (which calls this, then writes).
 *
 * `overrides` is passed in rather than read from disk: pending decisions
 * live in the browser until the user applies them, so they arrive in the
 * request body. Only the tool cache and proxy bookkeeping still come from
 * managed state.
 */
export async function planEmit(
  source: SourceGraph,
  overrides: OverrideMap,
): Promise<EmitPlan> {
  const state = await readManagedState();
  const settings = await readJsonFile<SettingsShape>(SETTINGS_PATH, {});
  const mcpConfig = await readJsonFile<McpConfigShape>(MCP_CONFIG_PATH, {
    mcpServers: {},
  });

  const originalSettingsJson = JSON.stringify(settings);
  const originalMcpConfigJson = JSON.stringify(mcpConfig);

  const nodesByKey = new Map<string, SourceNode>();
  for (const node of source.nodes) nodesByKey.set(nodeKey(node.id), node);

  const changes: EmitChange[] = [];
  const skipped: EmitSkip[] = [];

  for (const [key, override] of Object.entries(overrides)) {
    const node = nodesByKey.get(key);
    if (!node) {
      skipped.push({
        nodeKey: key,
        reason: ORPHANED_OVERRIDE_REASON,
      });
      continue;
    }

    // An override equal to the source value would write the bytes that are
    // already there. The client drops these as they are made, but the source
    // config can shift underneath a decision that is still waiting, so this
    // is checked again here against what was just read from disk.
    if (override.enabled === node.sourceEnabled) continue;

    switch (node.controllable.type) {
      case "settingsPluginToggle": {
        const settingsKey = (node.raw as { settingsKey?: string } | undefined)
          ?.settingsKey;
        if (!settingsKey) {
          skipped.push({
            nodeKey: key,
            reason: "Plugin has no resolvable settings key.",
          });
          break;
        }
        settings.enabledPlugins = {
          ...(settings.enabledPlugins ?? {}),
          [settingsKey]: override.enabled,
        };
        changes.push({
          file: SETTINGS_PATH,
          description: `enabledPlugins["${settingsKey}"] = ${override.enabled}`,
        });
        break;
      }
      case "settingsMcpToggle": {
        settings.disabledMcpServers = override.enabled
          ? setRemove(settings.disabledMcpServers, node.id.name)
          : setAdd(settings.disabledMcpServers, node.id.name);
        changes.push({
          file: SETTINGS_PATH,
          description: `disabledMcpServers ${override.enabled ? "-" : "+"} "${node.id.name}"`,
        });
        break;
      }
      case "settingsSkillToggle": {
        settings.disabledSkills = override.enabled
          ? setRemove(settings.disabledSkills, node.id.name)
          : setAdd(settings.disabledSkills, node.id.name);
        changes.push({
          file: SETTINGS_PATH,
          description: `disabledSkills ${override.enabled ? "-" : "+"} "${node.id.name}"`,
        });
        break;
      }
      case "settingsAllHooksToggle": {
        // Stored inverted: the node reads "hooks run", the setting reads
        // "hooks are off". Writing `override.enabled` straight through would
        // switch every hook to exactly the wrong state.
        settings.disableAllHooks = !override.enabled;
        changes.push({
          file: SETTINGS_PATH,
          description: `disableAllHooks = ${!override.enabled}`,
        });
        break;
      }
      case "hookToggle": {
        // Handled in a dedicated pass below (planHookToggles). One logical
        // hook can own several raw entries in several arrays, and removing
        // one shifts the indices of the rest, so they have to be planned per
        // file rather than per node.
        break;
      }
      case "mcpToolFilter": {
        // Handled in a dedicated pass below (planDirectToolFilters /
        // planProxyRewrites): correctly filtering a tool requires seeing
        // the server's *entire* tool inventory at once (to tell a true
        // wildcard from "some tools disabled"), not just the one node
        // being iterated here.
        break;
      }
      case "readonly": {
        skipped.push({ nodeKey: key, reason: control_reason(node) });
        break;
      }
    }
  }

  planDirectToolFilters(
    source,
    nodesByKey,
    overrides,
    mcpConfig,
    changes,
    skipped,
  );

  const hookStateUpdates: HookStateUpdate[] = [];
  const hookFiles = await planHookToggles(
    nodesByKey,
    overrides,
    state,
    settings,
    changes,
    skipped,
    hookStateUpdates,
  );

  const proxyStateUpdates: ProxyStateUpdate[] = [];
  const pluginFiles = await planProxyRewrites(
    source,
    nodesByKey,
    overrides,
    state,
    changes,
    skipped,
    proxyStateUpdates,
  );

  return {
    settings,
    mcpConfig,
    settingsChanged: JSON.stringify(settings) !== originalSettingsJson,
    mcpConfigChanged: JSON.stringify(mcpConfig) !== originalMcpConfigJson,
    pluginFiles,
    hookFiles,
    changes,
    skipped,
    proxyStateUpdates,
    hookStateUpdates,
  };
}

/**
 * Handles `mcpToolFilter` nodes with `writable: "direct"` — user-scope MCP
 * servers whose `tools[]` array lives straight in mcp-config.json.
 *
 * This recomputes the *entire* `tools` array from the server's full tool
 * inventory (`source.nodes`, which already reflects the loaded tools) each
 * time, rather than incrementally add/removing one name. Incremental edits
 * are wrong the moment the array starts as a wildcard: `remove("*", "x")`
 * is a no-op (nothing is literally named "x" in `["*"]`), so a disabled
 * tool would silently stay enabled. Only servers with at least one tool
 * override are touched; per-tool +/- lines are still emitted so the diff
 * view reads the same as before.
 */
function planDirectToolFilters(
  source: SourceGraph,
  nodesByKey: Map<string, SourceNode>,
  overrides: OverrideMap,
  mcpConfig: McpConfigShape,
  changes: EmitChange[],
  skipped: EmitSkip[],
): void {
  const toolsByMcpKey = new Map<string, SourceNode[]>();
  for (const node of source.nodes) {
    if (
      node.id.kind === "tool" &&
      node.controllable.type === "mcpToolFilter" &&
      node.controllable.writable === "direct" &&
      node.id.parentKey
    ) {
      const list = toolsByMcpKey.get(node.id.parentKey) ?? [];
      list.push(node);
      toolsByMcpKey.set(node.id.parentKey, list);
    }
  }

  for (const [mcpKey, toolNodes] of toolsByMcpKey) {
    const hasOverride = toolNodes.some((t) => nodeKey(t.id) in overrides);
    if (!hasOverride) continue;

    const mcpNode = nodesByKey.get(mcpKey);
    const serverName = mcpNode?.id.name;
    if (!serverName) {
      skipped.push({
        nodeKey: mcpKey,
        reason: ORPHANED_OVERRIDE_REASON,
      });
      continue;
    }
    const serverConfig = mcpConfig.mcpServers?.[serverName];
    if (!serverConfig) {
      skipped.push({
        nodeKey: mcpKey,
        reason: `Server "${serverName}" not found in mcp-config.json.`,
      });
      continue;
    }

    const currentTools = serverConfig.tools;
    const currentIsWildcard =
      !currentTools || (currentTools.length === 1 && currentTools[0] === "*");
    // The "as declared" enabled set, used as the baseline for tools that
    // have no override of their own.
    const previousEnabled = new Set(
      currentIsWildcard ? toolNodes.map((t) => t.id.name) : currentTools,
    );

    const nextEnabled = new Set<string>();
    for (const tool of toolNodes) {
      const override = overrides[nodeKey(tool.id)];
      const enabled = override ? override.enabled : tool.sourceEnabled;
      if (enabled) nextEnabled.add(tool.id.name);
    }

    let anyChange = false;
    const allNames = new Set([...previousEnabled, ...nextEnabled]);
    for (const name of allNames) {
      const was = previousEnabled.has(name);
      const now = nextEnabled.has(name);
      if (was === now) continue;
      anyChange = true;
      changes.push({
        file: MCP_CONFIG_PATH,
        description: `mcpServers.${serverName}.tools ${now ? "+" : "-"} "${name}"`,
      });
    }
    if (!anyChange) continue;

    const allEnabled = toolNodes.every((t) => nextEnabled.has(t.id.name));
    serverConfig.tools = allEnabled ? ["*"] : Array.from(nextEnabled);
  }
}

/**
 * Applies per-hook enable/disable by editing the hook arrays themselves.
 *
 * Copilot has no per-hook enable setting, so switching a hook off means
 * deleting its entries. To make that reversible, every deleted entry is
 * stashed verbatim in managed state (`disabledHooks`) along with the index
 * it came from, and re-enabling splices it straight back.
 *
 * One logical hook usually owns more than one raw entry, because plugins
 * declare the same hook under both the camelCase and PascalCase spelling of
 * its event. All of them move together.
 */
async function planHookToggles(
  nodesByKey: Map<string, SourceNode>,
  overrides: OverrideMap,
  state: ManagedState,
  settings: SettingsShape,
  changes: EmitChange[],
  skipped: EmitSkip[],
  updates: HookStateUpdate[],
): Promise<Record<string, unknown>> {
  const hookFiles: Record<string, unknown> = {};

  /**
   * Every hook in one file has to be planned against the same in-memory
   * copy. Re-reading per hook would make each one splice against the
   * pristine file and silently drop all but the last edit.
   */
  const loadFile = async (path: string): Promise<HookFileShape> => {
    if (path === SETTINGS_PATH) {
      settings.hooks ??= {};
      return settings as HookFileShape;
    }
    if (!(path in hookFiles)) {
      hookFiles[path] = await readJsonFile<HookFileShape>(path, { hooks: {} });
    }
    const file = hookFiles[path] as HookFileShape;
    file.hooks ??= {};
    return file;
  };

  for (const [key, override] of Object.entries(overrides)) {
    const node = nodesByKey.get(key);
    if (!node || node.controllable.type !== "hookToggle") continue;
    if (override.enabled === node.sourceEnabled) continue;

    const raw = node.raw as HookNodeRaw;
    const control = node.controllable;

    let file: HookFileShape;
    try {
      file = await loadFile(control.file);
    } catch {
      skipped.push({
        nodeKey: key,
        reason: `Could not read hook file ${control.file}.`,
      });
      continue;
    }
    const hooks = file.hooks as Record<string, unknown[]>;

    if (!override.enabled) {
      // Descending index order per event: splicing low-to-high shifts every
      // later entry down one and removes the wrong ones.
      const byEvent = new Map<string, DisabledHookEntry[]>();
      for (const entry of raw.entries) {
        const list = byEvent.get(entry.event) ?? [];
        list.push(entry);
        byEvent.set(entry.event, list);
      }
      let removed = 0;
      for (const [event, entries] of byEvent) {
        const arr = hooks[event];
        if (!Array.isArray(arr)) continue;
        for (const entry of [...entries].sort((a, b) => b.index - a.index)) {
          const at = arr.findIndex((v) => sameConfigValue(v, entry.entry));
          if (at === -1) continue;
          arr.splice(at, 1);
          removed++;
        }
      }
      if (removed === 0) {
        skipped.push({
          nodeKey: key,
          reason: `Hook entries were not found in ${control.file}; it may have been edited outside this app.`,
        });
        continue;
      }
      updates.push({
        hookKey: key,
        action: "stash",
        record: {
          file: control.file,
          target: control.target,
          event: raw.event,
          command: raw.command,
          matcher: raw.matcher,
          timeoutSec: raw.timeoutSec,
          scope: node.id.scope,
          pluginName: node.providedBy?.name,
          providedByKey: node.providedBy ? nodeKey(node.providedBy) : undefined,
          entries: raw.entries,
          disabledAt: new Date().toISOString(),
        },
      });
      changes.push({
        file: control.file,
        description: `hooks.${raw.event} - "${raw.command}" (${removed} ${removed === 1 ? "entry" : "entries"}, stashed)`,
      });
    } else {
      const stashed = state.disabledHooks[key]?.entries ?? raw.entries;
      let restored = 0;
      for (const entry of [...stashed].sort((a, b) => a.index - b.index)) {
        const arr = (hooks[entry.event] ??= []);
        // The plugin may have shipped this hook back in an update. Adding a
        // second identical entry would make the command run twice.
        if (arr.some((v) => sameConfigValue(v, entry.entry))) continue;
        arr.splice(Math.min(entry.index, arr.length), 0, entry.entry);
        restored++;
      }
      updates.push({ hookKey: key, action: "clear" });
      changes.push({
        file: control.file,
        description:
          restored === 0
            ? `hooks.${raw.event} "${raw.command}" already present (stash cleared)`
            : `hooks.${raw.event} + "${raw.command}" (${restored} ${restored === 1 ? "entry" : "entries"} restored)`,
      });
    }
  }

  return hookFiles;
}

/**
 * Handles the `writable: "proxy-required"` case: plugin-declared MCP
 * servers whose tools need filtering. For every affected server (one with
 * a proxy-required tool override, or one already proxied from a previous
 * apply), recomputes the allowlist from current overrides and either:
 *  - rewrites the plugin's `.mcp.json` entry to launch `src/proxy/bin.ts`
 *    with the real upstream config + allowlist, or
 *  - restores the original entry once every tool is enabled again.
 */
async function planProxyRewrites(
  source: SourceGraph,
  nodesByKey: Map<string, SourceNode>,
  overrides: OverrideMap,
  state: ManagedState,
  changes: EmitChange[],
  skipped: EmitSkip[],
  proxyStateUpdates: ProxyStateUpdate[],
): Promise<Record<string, unknown>> {
  const affectedMcpKeys = new Set<string>(Object.keys(state.proxiedServers));
  for (const [key, node] of nodesByKey) {
    if (
      node.id.kind === "tool" &&
      node.controllable.type === "mcpToolFilter" &&
      node.controllable.writable === "proxy-required" &&
      node.id.parentKey
    ) {
      // Same no-op rule as the main loop: an override restating the source
      // value must not pull an entire server into the proxy plan.
      const override = overrides[key];
      if (!override || override.enabled === node.sourceEnabled) continue;
      affectedMcpKeys.add(node.id.parentKey);
    }
  }
  if (affectedMcpKeys.size === 0) return {};

  const fileCache = new Map<string, McpConfigShape>();
  const pluginFiles: Record<string, unknown> = {};

  for (const mcpKey of affectedMcpKeys) {
    const mcpNode = nodesByKey.get(mcpKey);
    if (!mcpNode) {
      skipped.push({
        nodeKey: mcpKey,
        reason: "Proxied server no longer exists in the discovered setup.",
      });
      continue;
    }
    const filePath = mcpNode.files[0];
    if (!filePath) {
      skipped.push({
        nodeKey: mcpKey,
        reason: "Could not resolve the plugin file that declares this server.",
      });
      continue;
    }

    const toolChildren = source.nodes.filter(
      (n) => n.id.kind === "tool" && n.id.parentKey === mcpKey,
    );

    const fileJson =
      fileCache.get(filePath) ??
      (await readJsonFile<McpConfigShape>(filePath, { mcpServers: {} }));
    fileCache.set(filePath, fileJson);
    const entry = fileJson.mcpServers?.[mcpNode.id.name];
    if (!entry) {
      skipped.push({
        nodeKey: mcpKey,
        reason: `Server "${mcpNode.id.name}" not found in ${filePath}.`,
      });
      continue;
    }

    const original =
      state.proxiedServers[mcpKey] ??
      (entry[PROXY_MARKER] ? undefined : { ...entry });
    if (!original) {
      skipped.push({
        nodeKey: mcpKey,
        reason: `No stashed original config for an already-proxied server; re-toggle all its tools on to restore it manually.`,
      });
      continue;
    }

    // A proxy is needed only when the wanted set differs from what the
    // server's own declaration already exposes.
    //
    // Counting switched-off tools instead would be wrong in both
    // directions. A plugin that declares 9 of its 98 tools leaves 89
    // permanently "off", so its proxy could never be torn down; and on a
    // server with nothing stashed, asking for every tool would count zero
    // off, write nothing, and silently drop the request.
    const desiredEnabled = new Set(
      toolChildren
        .filter((t) => {
          const ov = overrides[nodeKey(t.id)];
          return ov ? ov.enabled : t.sourceEnabled;
        })
        .map((t) => t.id.name),
    );
    const declaredEnabled = declaredEnabledNames(
      original,
      toolChildren.map((t) => t.id.name),
    );
    const needsProxy = !sameNameSet(desiredEnabled, declaredEnabled);

    if (!needsProxy) {
      const wasProxied =
        mcpKey in state.proxiedServers || Boolean(entry[PROXY_MARKER]);
      if (wasProxied && !sameConfigValue(entry, original)) {
        fileJson.mcpServers![mcpNode.id.name] =
          original as McpConfigShape["mcpServers"] extends Record<
            string,
            infer V
          >
            ? V
            : never;
        changes.push({
          file: filePath,
          description: `Restored original declaration for "${mcpNode.id.name}" (proxy no longer needed).`,
        });
        pluginFiles[filePath] = fileJson;
      }
      // else: the entry on disk already matches its own declaration — a
      // true no-op, so skip touching the file at all.
      proxyStateUpdates.push({ mcpKey, action: "clear" });
      continue;
    } else {
      const allowed = toolChildren
        .map((t) => t.id.name)
        .filter((name) => desiredEnabled.has(name));
      const launcher = buildProxyLauncher(original, allowed);

      proxyStateUpdates.push({
        mcpKey,
        action: "stash",
        original: original as Record<string, unknown>,
      });

      // Every already-proxied server is examined on each plan, so that a
      // proxy can be torn down once its tools are all back on. Most of the
      // time that produces the launcher already on disk, which is not a
      // change and must not be reported as one.
      if (sameConfigValue(entry, launcher)) continue;
      fileJson.mcpServers![mcpNode.id.name] = launcher;
      changes.push({
        file: filePath,
        description: `Routed "${mcpNode.id.name}" through the MCP proxy, allowing: ${allowed.join(", ") || "(none)"}`,
      });
    }
    pluginFiles[filePath] = fileJson;
  }

  return pluginFiles;
}

/**
 * Names a server's original declaration leaves enabled.
 *
 * `tools[]` is a filter, not an inventory: absent, empty or `["*"]` all mean
 * "every tool this server has", which is only knowable from the loaded
 * inventory. Names are narrowed to that inventory so the result can be
 * compared with a wanted set drawn from the same list. When the inventory is
 * unknown the comparison collapses to empty on both sides, which falls back
 * to the plugin's own declaration rather than pinning a proxy in place.
 */
function declaredEnabledNames(
  original: unknown,
  inventory: string[],
): Set<string> {
  const declared = (original as { tools?: unknown } | undefined)?.tools;
  const list = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === "string")
    : [];
  const isWildcard =
    list.length === 0 || (list.length === 1 && list[0] === "*");
  if (isWildcard) return new Set(inventory);
  const known = new Set(inventory);
  return new Set(list.filter((name) => known.has(name)));
}

function sameNameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

/**
 * Compares two config entries by value, ignoring key order.
 *
 * Used to tell a real rewrite from one that would put back the bytes
 * already on disk. Key order differs freely between an entry parsed from a
 * file and one built here, so a plain `JSON.stringify` comparison would
 * report spurious changes.
 */
function sameConfigValue(a: unknown, b: unknown): boolean {
  const stable = (value: unknown) =>
    JSON.stringify(value, (_key, inner) =>
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.entries(inner as Record<string, unknown>).sort(
              ([left], [right]) => left.localeCompare(right),
            ),
          )
        : inner,
    );
  return stable(a) === stable(b);
}

function control_reason(node: SourceNode): string {
  return node.controllable.type === "readonly"
    ? node.controllable.reason
    : "Not controllable.";
}

async function writeJsonFileAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export interface ApplyResult {
  snapshotId: string;
  changes: EmitChange[];
  skipped: EmitSkip[];
}

/**
 * Applies `overrides` to the real Copilot config: snapshots every file that
 * could change first (even if only some actually change, for a consistent
 * revert point), writes the ones that did, and returns what happened.
 */
export async function applyEmit(overrides: OverrideMap): Promise<ApplyResult> {
  const source = await discoverSourceGraph();
  const plan = await planEmit(source, overrides);

  const pluginFilePaths = Object.keys(plan.pluginFiles);
  const hookFilePaths = Object.keys(plan.hookFiles);
  const snapshot = await createSnapshot(
    [SETTINGS_PATH, MCP_CONFIG_PATH, ...pluginFilePaths, ...hookFilePaths],
    "apply",
  );

  if (plan.settingsChanged)
    await writeJsonFileAtomic(SETTINGS_PATH, plan.settings);
  if (plan.mcpConfigChanged)
    await writeJsonFileAtomic(MCP_CONFIG_PATH, plan.mcpConfig);
  for (const path of pluginFilePaths) {
    await writeJsonFileAtomic(path, plan.pluginFiles[path]);
  }
  for (const path of hookFilePaths) {
    await writeJsonFileAtomic(path, plan.hookFiles[path]);
  }

  // Committed only now that the files are actually on disk. Doing this during
  // planning would make a read-only `/api/diff` preview leave the server
  // permanently marked as proxied.
  for (const update of plan.proxyStateUpdates) {
    if (update.action === "stash") {
      await setProxiedServerOriginal(update.mcpKey, update.original);
    } else {
      await clearProxiedServerOriginal(update.mcpKey);
    }
  }

  // Same rule for hooks, and the stakes are higher: stashing before the write
  // lands would record a hook as disabled while its entries are still in the
  // file, and discovery treats the file as the winner — so the stash would
  // never be shown and the user could not switch it back on.
  for (const update of plan.hookStateUpdates) {
    if (update.action === "stash") {
      await setDisabledHook(update.hookKey, update.record);
    } else {
      await clearDisabledHook(update.hookKey);
    }
  }

  return {
    snapshotId: snapshot.id,
    changes: plan.changes,
    skipped: plan.skipped,
  };
}
