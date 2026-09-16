/**
 * Normalizes Copilot CLI output + filesystem scan results into a single
 * `SourceGraph`. This is the only module that should be imported by
 * `core/graph.ts` — everything upstream of this file is Copilot-specific
 * plumbing; everything downstream is Copilot-agnostic, so a future adapter
 * for another AI client only needs to produce the same `SourceGraph` shape.
 */
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type {
  DisabledHookRecord,
  Scope,
  SourceGraph,
  SourceNode,
  ControlMode,
  NodeId,
} from "@/core/types";
import { nodeKey } from "@/core/types";
import { getMcpList, getPluginsList, getSkillList } from "./cli";
import {
  derivePluginRootFromSkillPath,
  groupHookEntries,
  listPluginFiles,
  pluginHookFilePath,
  readDisableAllHooks,
  readPluginManifest,
  scanHookFile,
  scanPluginAgents,
  scanPluginMcpConfig,
  scanPluginSkills,
  scanSettingsHooks,
  scanUserAgents,
  type AgentFile,
  type LogicalHook,
} from "./scanner";
import { resolvePluginRoot } from "./plugin-root";
import type { McpServerEntry, PluginsListEntry } from "./schema";
import { readManagedState } from "@/core/state";

/**
 * Resolves the absolute `.mcp.json` path that declares a plugin-scope MCP
 * server, so `core/emit.ts` knows which file to rewrite when it needs the
 * proxy fallback for per-tool filtering. Returns `[]` for user-scope
 * servers (declared directly in `~/.copilot/mcp-config.json`, which
 * `emit.ts` already knows how to reach on its own).
 */
function mcpSourceFile(
  sourcePlugin: string | undefined,
  pluginRootByName: Map<string, string>,
  manifestByPlugin: Map<string, Awaited<ReturnType<typeof readPluginManifest>>>,
): string[] {
  if (!sourcePlugin) return [];
  const root = pluginRootByName.get(sourcePlugin);
  if (!root) return [];
  const manifest = manifestByPlugin.get(sourcePlugin);
  return [join(root, manifest?.mcpServers ?? ".mcp.json")];
}

interface ToolInventoryEntry {
  name: string;
  description?: string;
  /** Whether this tool is inside the server's `tools[]` allowlist filter. */
  enabledInConfig: boolean;
}

/** Marks an entry this app rewrote to launch the tool-filtering proxy. */
const PROXY_MARKER = "_aiSetupManagerProxy";

interface DeclaredTools {
  names: string[];
  /** True when the declaration means "every tool this server has". */
  isWildcard: boolean;
}

/**
 * Works out a server's declared tool allowlist.
 *
 * Normally that is the `tools[]` array, where an empty/absent array or
 * `["*"]` means "everything". But once this app has routed a server through
 * the proxy, the on-disk entry is the proxy launcher and the real allowlist
 * is its `--allow` argument.
 *
 * The launcher is recognised by its arguments rather than by the
 * `_aiSetupManagerProxy` marker this app writes beside them. `copilot mcp
 * list --json` reports a normalised entry: it drops unknown keys like the
 * marker and fills in a default `tools: ["*"]` that was never written. Going
 * by the marker alone would therefore read every proxied server as a
 * wildcard, show all of its tools as enabled, and make the next apply
 * silently tear the proxy down and undo the user's filter.
 */
function resolveDeclaredTools(raw: unknown, tools: string[]): DeclaredTools {
  const entry = raw as { [PROXY_MARKER]?: boolean; args?: unknown } | undefined;
  const args = Array.isArray(entry?.args) ? (entry.args as unknown[]) : [];
  const isProxyLauncher =
    entry?.[PROXY_MARKER] === true ||
    (args.includes("--upstream") && args.includes("--allow"));

  if (isProxyLauncher) {
    const flagIndex = args.indexOf("--allow");
    const value = flagIndex === -1 ? undefined : args[flagIndex + 1];
    // Mirror the proxy's own parsing in `src/proxy/bin.ts`. An absent flag
    // or a literal `*` is unfiltered; an empty value is a real, empty
    // allowlist. Reading those two the same way would either hide a filter
    // that is running or invent one that is not there.
    if (value === undefined || value === "*") {
      return { names: [], isWildcard: true };
    }
    const names =
      typeof value === "string"
        ? value
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [];
    return { names, isWildcard: false };
  }
  const isWildcard =
    tools.length === 0 || (tools.length === 1 && tools[0] === "*");
  return { names: isWildcard ? [] : tools, isWildcard };
}

/**
 * Computes the real tool inventory for an MCP server.
 *
 * `tools[]` in mcp-config.json (or a plugin's `.mcp.json`) is a filter, not
 * an inventory: a wildcard `["*"]` (or an absent `tools` key) means "every
 * tool the server has", not "no tools". The only way to know what that
 * really is, is to have asked the live server via `tools/list` — a loaded
 * inventory takes priority whenever one exists. Without it, a wildcard
 * server's inventory is unknown (empty list); a server with an explicit
 * list uses that list as both its inventory and its enabled set.
 *
 * Any tool the declaration names but the server did not report is still
 * listed. Reading a proxied server only sees the tools the proxy allows,
 * and dropping the rest would make disabled tools vanish from the UI with
 * no way to switch them back on.
 */
function computeToolInventory(
  declared: DeclaredTools,
  loaded:
    | {
        ok: boolean;
        stale?: boolean;
        tools: { name: string; description?: string }[];
      }
    | undefined,
): { entries: ToolInventoryEntry[]; discovered: boolean } {
  const { names, isWildcard } = declared;
  const declaredSet = new Set(names);

  // A `stale` result is a failed re-read whose `tools` were backfilled from
  // the last successful one (see core/state.ts mergeToolLoadResult) — it
  // still reflects a real discovered inventory, just possibly out of date,
  // so it must render the same as a fresh `ok` result rather than fall
  // back to "unknown".
  if ((loaded?.ok || loaded?.stale) && loaded.tools.length > 0) {
    const entries: ToolInventoryEntry[] = loaded.tools.map((t) => ({
      name: t.name,
      description: t.description,
      enabledInConfig: isWildcard ? true : declaredSet.has(t.name),
    }));

    if (!isWildcard) {
      const reported = new Set(entries.map((e) => e.name));
      for (const name of names) {
        if (!reported.has(name)) entries.push({ name, enabledInConfig: true });
      }
    }

    return { discovered: true, entries };
  }

  if (isWildcard) {
    return { discovered: false, entries: [] };
  }

  return {
    discovered: false,
    entries: names.map((name) => ({ name, enabledInConfig: true })),
  };
}

function mapListScope(scope: string): Scope {
  switch (scope) {
    case "user":
    case "session":
      return "user";
    case "repository":
      return "repository";
    case "working-directory":
      return "workspace";
    case "plugin":
      return "plugin";
    case "builtin":
      return "builtin";
    default:
      return "unknown";
  }
}

function mapMcpScope(scope: string | undefined): Scope {
  switch (scope) {
    case "user":
      return "user";
    case "plugin":
      return "plugin";
    case "workspace":
      return "workspace";
    case "builtin":
      return "builtin";
    default:
      return "unknown";
  }
}

/** `<plugin>@<marketplace>` — the key format `settings.json`'s `enabledPlugins` uses. */
export function pluginSettingsKey(entry: PluginsListEntry): string | undefined {
  const match = /^(?:marketplace|live-marketplace):(.+)$/.exec(
    entry.source ?? "",
  );
  if (!match) return undefined;
  return `${entry.name}@${match[1]}`;
}

function agentNode(
  agent: AgentFile,
  scope: Scope,
  providedBy?: NodeId,
): SourceNode {
  // parentKey disambiguates same-named agents contributed by different
  // plugins (mirrors how tool ids are scoped under their MCP server).
  const id: NodeId = {
    kind: "agent",
    name: agent.name,
    scope,
    parentKey: providedBy ? nodeKey(providedBy) : undefined,
  };
  return {
    id,
    displayName: agent.name,
    description: agent.description,
    sourceEnabled: true,
    controllable: {
      type: "readonly",
      reason:
        "Copilot has no disabledAgents setting — agents cannot be toggled individually.",
    },
    files: [agent.filePath],
    raw: agent.raw,
    providedBy,
    provides: [],
  };
}

export const SETTINGS_PATH = join(homedir(), ".copilot", "settings.json");

/** Trailing path segment of a hook command, e.g. `danger-guard.sh`. */
function hookDisplayName(command: string): string {
  const trimmed = command.split(/[?\s]/)[0];
  const segment = trimmed.split("/").pop();
  return segment && segment.length > 0 ? segment : command;
}

function hookDescription(event: string, matcher: string | undefined): string {
  return matcher ? `${event} · matches ${matcher}` : event;
}

/**
 * Builds the node for a hook that is present in its file.
 *
 * `name` embeds the event and the command rather than a hash, because it is
 * also the stash key in `managedState.disabledHooks` — a key a human may
 * have to read, and reconcile with a file, long after the fact.
 */
function hookNode(
  hook: LogicalHook,
  scope: Scope,
  target: "settings" | "hooksFile",
  file: string,
  providedBy?: NodeId,
): SourceNode {
  const id: NodeId = {
    kind: "hook",
    name: `${hook.normalizedEvent}:${hook.command}`,
    scope,
    parentKey: providedBy ? nodeKey(providedBy) : undefined,
  };
  return {
    id,
    displayName: hookDisplayName(hook.command),
    description: hookDescription(hook.normalizedEvent, hook.matcher),
    sourceEnabled: true,
    controllable: { type: "hookToggle", target, file },
    files: [file],
    raw: {
      event: hook.normalizedEvent,
      command: hook.command,
      matcher: hook.matcher,
      timeoutSec: hook.timeoutSec,
      entries: hook.entries.map((e) => ({
        event: e.event,
        index: e.index,
        entry: e.entry,
      })),
    },
    providedBy,
    provides: [],
  };
}

/**
 * Rebuilds the node for a hook the user switched off.
 *
 * A disabled hook has been deleted from its file, so every display field has
 * to come from the stash — there is nothing left on disk to read. Without
 * this the row would simply vanish and could never be switched back on,
 * which is the whole problem the stash exists to solve.
 */
function disabledHookNode(
  key: string,
  record: DisabledHookRecord,
  providedBy: NodeId | undefined,
): SourceNode {
  const id: NodeId = {
    kind: "hook",
    name: `${record.event}:${record.command}`,
    scope: record.scope,
    parentKey: record.providedByKey,
  };
  return {
    id,
    displayName: hookDisplayName(record.command),
    description: hookDescription(record.event, record.matcher),
    sourceEnabled: false,
    controllable: {
      type: "hookToggle",
      target: record.target,
      file: record.file,
    },
    files: [record.file],
    raw: {
      event: record.event,
      command: record.command,
      matcher: record.matcher,
      timeoutSec: record.timeoutSec,
      disabledAt: record.disabledAt,
      stashKey: key,
      entries: record.entries,
    },
    providedBy,
    provides: [],
  };
}

export async function discoverSourceGraph(): Promise<SourceGraph> {
  const warnings: string[] = [];
  const nodes: SourceNode[] = [];

  const [
    pluginsRes,
    mcpRes,
    skillRes,
    userAgents,
    managedState,
    settingsDisablesAllHooks,
  ] = await Promise.all([
    getPluginsList(),
    getMcpList(),
    getSkillList(),
    scanUserAgents(),
    readManagedState(),
    readDisableAllHooks(SETTINGS_PATH),
  ]);
  const toolCache = managedState.toolCache;

  if (!pluginsRes.ok) warnings.push(pluginsRes.error);
  if (!mcpRes.ok) warnings.push(mcpRes.error);
  if (!skillRes.ok) warnings.push(skillRes.error);

  const pluginEntries = pluginsRes.ok
    ? pluginsRes.data.plugins.filter((p) => p.kind === "plugin")
    : [];
  const instructionEntries = pluginsRes.ok
    ? pluginsRes.data.plugins.filter((p) => p.kind === "instruction")
    : [];

  // --- Plugins (also resolves each plugin's filesystem root) ---
  const pluginIdByName = new Map<string, NodeId>();
  const pluginRootByName = new Map<string, string>();
  const manifestByPlugin = new Map<
    string,
    Awaited<ReturnType<typeof readPluginManifest>>
  >();

  for (const entry of pluginEntries) {
    const scope = mapListScope(entry.scope);
    const id: NodeId = { kind: "plugin", name: entry.name, scope };
    pluginIdByName.set(entry.name, id);

    const root = await resolvePluginRoot(entry);
    if (root) pluginRootByName.set(entry.name, root);
    else
      warnings.push(
        `Could not resolve filesystem root for plugin "${entry.name}"`,
      );

    const manifest = root ? await readPluginManifest(root) : null;
    manifestByPlugin.set(entry.name, manifest);
    const files = root ? await listPluginFiles(root) : [];

    const control: ControlMode = pluginSettingsKey(entry)
      ? { type: "settingsPluginToggle" }
      : { type: "readonly", reason: "Built-in or unmanaged plugin source." };

    nodes.push({
      id,
      displayName: entry.name,
      description: manifest?.description ?? entry.description,
      sourceEnabled: entry.enabled ?? false,
      controllable: control,
      files: root ? [root, ...files] : [],
      raw: {
        ...entry,
        settingsKey: pluginSettingsKey(entry),
        manifest: manifest?.raw,
      },
      provides: [],
      version: entry.version ?? manifest?.version,
    });
  }

  // --- MCP servers (+ statically-declared tools, when not a "*" wildcard) ---
  const mcpEntries: [string, McpServerEntry][] = mcpRes.ok
    ? Object.entries(mcpRes.data.servers)
    : [];
  const mcpServerNamesByPlugin = new Map<string, Set<string>>();

  for (const [name, entry] of mcpEntries) {
    const scope = mapMcpScope(entry.source);
    const providedBy = entry.sourcePlugin
      ? pluginIdByName.get(entry.sourcePlugin)
      : undefined;
    // parentKey disambiguates same-named MCP servers declared by different
    // plugins (observed for real: both rc-plugin and rhub-plugin ship a
    // server literally named "density-mcp").
    const id: NodeId = {
      kind: "mcp",
      name,
      scope,
      parentKey: providedBy ? nodeKey(providedBy) : undefined,
    };
    if (entry.sourcePlugin) {
      const set = mcpServerNamesByPlugin.get(entry.sourcePlugin) ?? new Set();
      set.add(name);
      mcpServerNamesByPlugin.set(entry.sourcePlugin, set);
    }

    const declaredIn: "user" | "plugin" = scope === "user" ? "user" : "plugin";
    const loaded = toolCache[nodeKey(id)];
    const { entries: inventory, discovered } = computeToolInventory(
      resolveDeclaredTools(entry, entry.tools),
      loaded,
    );

    const provides: NodeId[] = [];
    for (const tool of inventory) {
      const toolId: NodeId = {
        kind: "tool",
        name: tool.name,
        scope,
        parentKey: nodeKey(id),
      };
      provides.push(toolId);
      nodes.push({
        id: toolId,
        displayName: tool.name,
        description: tool.description,
        sourceEnabled: tool.enabledInConfig,
        controllable: {
          type: "mcpToolFilter",
          server: name,
          declaredIn,
          writable: declaredIn === "user" ? "direct" : "proxy-required",
        },
        files: mcpSourceFile(
          entry.sourcePlugin,
          pluginRootByName,
          manifestByPlugin,
        ),
        raw: { server: name, discovered },
        providedBy: id,
        provides: [],
      });
    }

    nodes.push({
      id,
      displayName: name,
      sourceEnabled: entry.enabled ?? true,
      controllable: { type: "settingsMcpToggle" },
      files: mcpSourceFile(
        entry.sourcePlugin,
        pluginRootByName,
        manifestByPlugin,
      ),
      raw: entry,
      providedBy,
      provides,
    });

    if (providedBy) {
      const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(providedBy));
      parent?.provides.push(id);
    }
  }

  // --- Skills (path comes straight from the CLI) ---
  const skillNamesByPlugin = new Map<string, Set<string>>();
  if (skillRes.ok) {
    for (const entry of skillRes.data) {
      const scope: Scope =
        entry.source === "personal-copilot"
          ? "user"
          : entry.source === "plugin"
            ? "plugin"
            : entry.source === "repository"
              ? "repository"
              : "unknown";
      const id: NodeId = { kind: "skill", name: entry.name, scope };

      let providedBy: NodeId | undefined;
      let ownerName: string | undefined;
      if (scope === "plugin" && entry.path) {
        const root = derivePluginRootFromSkillPath(entry.path);
        ownerName = root ? basename(root) : undefined;
        providedBy = ownerName ? pluginIdByName.get(ownerName) : undefined;
      }
      // parentKey disambiguates same-named skills declared by different plugins.
      if (providedBy) id.parentKey = nodeKey(providedBy);
      if (ownerName) {
        const set = skillNamesByPlugin.get(ownerName) ?? new Set();
        set.add(entry.name);
        skillNamesByPlugin.set(ownerName, set);
      }

      nodes.push({
        id,
        displayName: entry.name,
        description: entry.description,
        sourceEnabled: entry.enabled ?? true,
        controllable: { type: "settingsSkillToggle" },
        files: entry.path ? [entry.path] : [],
        raw: entry,
        providedBy,
        provides: [],
      });

      if (providedBy) {
        const parent = nodes.find(
          (n) => nodeKey(n.id) === nodeKey(providedBy!),
        );
        parent?.provides.push(id);
      }
    }
  }

  // --- Agents (filesystem-only; not reported by the CLI) ---
  for (const agent of userAgents) {
    nodes.push(agentNode(agent, "user"));
  }

  // Every hook key found in a real file. A key in here wins over the same
  // key in the stash: `/api/revert` restores a hook file without clearing
  // the stash, so without this rule a reverted hook would be listed twice,
  // once enabled and once disabled.
  const seenHookKeys = new Set<string>();

  // --- User-scope hooks (settings.json's top-level `hooks` key) ---
  for (const hook of groupHookEntries(await scanSettingsHooks(SETTINGS_PATH))) {
    const node = hookNode(hook, "user", "settings", SETTINGS_PATH);
    nodes.push(node);
    seenHookKeys.add(nodeKey(node.id));
  }

  // --- The global `disableAllHooks` switch ---
  // Modelled as an enable toggle, so "on" reads as "hooks run" like every
  // other row. `core/emit.ts` inverts it back when writing the setting.
  nodes.push({
    id: { kind: "hook", name: "all-hooks", scope: "user" },
    displayName: "All hooks",
    description:
      "Master switch. Turning this off stops every hook running, user and plugin alike, without changing any hook file.",
    sourceEnabled: !settingsDisablesAllHooks,
    controllable: { type: "settingsAllHooksToggle" },
    files: [SETTINGS_PATH],
    raw: { disableAllHooks: settingsDisablesAllHooks },
    provides: [],
  });

  for (const [pluginName, root] of pluginRootByName) {
    const pluginId = pluginIdByName.get(pluginName);
    const agents = await scanPluginAgents(root);
    for (const agent of agents) {
      const node = agentNode(agent, "plugin", pluginId);
      nodes.push(node);
      if (pluginId) {
        const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(pluginId));
        parent?.provides.push(node.id);
      }
    }

    // --- Hooks (filesystem-only; one node per logical hook) ---
    // Each hook gets its own toggle. There is no Copilot setting behind it:
    // `core/emit.ts` disables one by deleting its entries from this file and
    // stashing them, and discovery merges the stash back in further down.
    const hookFile = pluginHookFilePath(
      root,
      manifestByPlugin.get(pluginName)?.hooks,
    );
    for (const hook of groupHookEntries(await scanHookFile(hookFile))) {
      const node = hookNode(hook, "plugin", "hooksFile", hookFile, pluginId);
      nodes.push(node);
      seenHookKeys.add(nodeKey(node.id));
      if (pluginId) {
        const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(pluginId));
        parent?.provides.push(node.id);
      }
    }

    // --- Fallback: MCP servers and skills the CLI doesn't report ---
    // `copilot mcp list` / `copilot skill list` only enumerate components of
    // *enabled* plugins. A disabled plugin's own declared components are
    // read directly from its files so navigation still works when it's off.
    const manifest = manifestByPlugin.get(pluginName) ?? null;
    const accountedMcp = mcpServerNamesByPlugin.get(pluginName) ?? new Set();
    const rawMcpServers = await scanPluginMcpConfig(
      root,
      manifest?.mcpServers ?? ".mcp.json",
    );
    for (const [serverName, raw] of Object.entries(rawMcpServers)) {
      if (accountedMcp.has(serverName)) continue;
      const mcpId: NodeId = {
        kind: "mcp",
        name: serverName,
        scope: "plugin",
        parentKey: pluginId ? nodeKey(pluginId) : undefined,
      };
      const declaredTools = raw.tools ?? ["*"];
      const loaded = toolCache[nodeKey(mcpId)];
      const { entries: inventory, discovered } = computeToolInventory(
        resolveDeclaredTools(raw, declaredTools),
        loaded,
      );
      const toolIds: NodeId[] = [];
      for (const tool of inventory) {
        const toolId: NodeId = {
          kind: "tool",
          name: tool.name,
          scope: "plugin",
          parentKey: nodeKey(mcpId),
        };
        toolIds.push(toolId);
        nodes.push({
          id: toolId,
          displayName: tool.name,
          description: tool.description,
          // The tool's own allowlist state, not the plugin's. The plugin
          // being off already forces every child off through the parent
          // cascade in `core/graph.ts`; hardcoding `false` here instead
          // would lose the real state and show every discovered tool
          // unchecked, so re-enabling the plugin would appear to disable
          // all its tools.
          sourceEnabled: tool.enabledInConfig,
          controllable: {
            type: "mcpToolFilter",
            server: serverName,
            declaredIn: "plugin",
            writable: "proxy-required",
          },
          files: [],
          raw: { server: serverName, discovered },
          providedBy: mcpId,
          provides: [],
        });
      }
      nodes.push({
        id: mcpId,
        displayName: serverName,
        description:
          "Not visible to `copilot mcp list` while the plugin is disabled.",
        sourceEnabled: false,
        controllable: { type: "settingsMcpToggle" },
        files: [join(root, manifest?.mcpServers ?? ".mcp.json")],
        raw,
        providedBy: pluginId,
        provides: toolIds,
      });
      if (pluginId) {
        const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(pluginId));
        parent?.provides.push(mcpId);
      }
    }

    const accountedSkills = skillNamesByPlugin.get(pluginName) ?? new Set();
    const rawSkills = await scanPluginSkills(root, manifest?.skills);
    for (const skill of rawSkills) {
      if (accountedSkills.has(skill.name)) continue;
      const skillId: NodeId = {
        kind: "skill",
        name: skill.name,
        scope: "plugin",
        parentKey: pluginId ? nodeKey(pluginId) : undefined,
      };
      nodes.push({
        id: skillId,
        displayName: skill.name,
        description: skill.description,
        sourceEnabled: false,
        controllable: { type: "settingsSkillToggle" },
        files: [skill.path],
        raw: skill,
        providedBy: pluginId,
        provides: [],
      });
      if (pluginId) {
        const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(pluginId));
        parent?.provides.push(skillId);
      }
    }
  }

  // --- Disabled hooks (stash-only; deleted from their files on purpose) ---
  // These have no on-disk declaration left, so the stash is the only record
  // of them. Merging them back as `sourceEnabled: false` is what keeps a
  // disabled hook visible and re-enableable instead of silently lost.
  for (const [key, record] of Object.entries(managedState.disabledHooks)) {
    if (seenHookKeys.has(key)) continue;
    const providedBy = record.providedByKey
      ? nodes.find((n) => nodeKey(n.id) === record.providedByKey)?.id
      : undefined;
    if (record.providedByKey && !providedBy) {
      warnings.push(
        `Disabled hook "${record.command}" belongs to a plugin that is no longer installed; re-enabling it will restore it to ${record.file}.`,
      );
    }
    const node = disabledHookNode(key, record, providedBy);
    nodes.push(node);
    if (providedBy) {
      const parent = nodes.find((n) => nodeKey(n.id) === nodeKey(providedBy));
      parent?.provides.push(node.id);
    }
  }

  // --- Instructions (read-only context, no enable mechanism) ---
  for (const entry of instructionEntries) {
    const scope = mapListScope(entry.scope);
    nodes.push({
      id: { kind: "instruction", name: entry.name, scope },
      displayName: entry.name,
      sourceEnabled: true,
      controllable: {
        type: "readonly",
        reason: "Instructions have no enable/disable mechanism in Copilot.",
      },
      files: [],
      raw: entry,
      provides: [],
    });
  }

  return { nodes, generatedAt: new Date().toISOString(), warnings };
}
