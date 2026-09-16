/**
 * Resolves the on-disk root directory of a plugin, given a
 * `plugins list --json` entry. Needed because that command reports
 * `installedFrom` (a marketplace directory, or nothing) rather than a
 * per-plugin path — the filesystem scanner needs a concrete plugin root
 * to find agents, hooks, and the plugin's file listing.
 *
 * Two marketplace shapes are handled, both generically (no marketplace
 * names are hardcoded):
 *   - `marketplace:<name>` — installed via `copilot plugin install`, cached
 *     under `~/.copilot/installed-plugins/<marketplace>/<plugin>`. The
 *     concrete cache path is read from `~/.copilot/config.json`'s
 *     `installedPlugins[].cache_path`.
 *   - `live-marketplace:<name>` — a directory-based marketplace declared in
 *     `settings.json`'s `extraKnownMarketplaces`. The plugin's relative
 *     `source` path is read from that directory's
 *     `.github/plugin/marketplace.json`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginsListEntry } from "./schema";

interface ConfigJsonInstalledPlugin {
  name: string;
  marketplace?: string;
  cache_path?: string;
}

interface MarketplaceManifestEntry {
  name: string;
  source?: string;
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

let installedPluginsCache: ConfigJsonInstalledPlugin[] | null = null;

async function getConfigJsonInstalledPlugins(): Promise<
  ConfigJsonInstalledPlugin[]
> {
  if (installedPluginsCache) return installedPluginsCache;
  const configPath = join(homedir(), ".copilot", "config.json");
  const raw = await readFile(configPath, "utf8").catch(() => null);
  if (!raw) return (installedPluginsCache = []);
  try {
    // config.json ships with a leading `//` comment line; strip lines
    // starting with // before parsing, since it is not strict JSON.
    const stripped = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(stripped) as {
      installedPlugins?: ConfigJsonInstalledPlugin[];
    };
    return (installedPluginsCache = parsed.installedPlugins ?? []);
  } catch {
    return (installedPluginsCache = []);
  }
}

const marketplaceManifestCache = new Map<string, MarketplaceManifestEntry[]>();

async function getLiveMarketplaceManifest(
  marketplaceDir: string,
): Promise<MarketplaceManifestEntry[]> {
  if (marketplaceManifestCache.has(marketplaceDir)) {
    return marketplaceManifestCache.get(marketplaceDir)!;
  }
  const manifestPath = join(
    marketplaceDir,
    ".github",
    "plugin",
    "marketplace.json",
  );
  const manifest = await readJsonSafe<{ plugins?: MarketplaceManifestEntry[] }>(
    manifestPath,
  );
  const plugins = manifest?.plugins ?? [];
  marketplaceManifestCache.set(marketplaceDir, plugins);
  return plugins;
}

/** Resolves the `marketplaceName` out of a `source` field like `marketplace:awesome-copilot`. */
function parseSourceTag(
  source: string | undefined,
): { kind: "marketplace" | "live-marketplace"; name: string } | null {
  if (!source) return null;
  const match = /^(marketplace|live-marketplace):(.+)$/.exec(source);
  if (!match) return null;
  return {
    kind: match[1] as "marketplace" | "live-marketplace",
    name: match[2],
  };
}

export async function resolvePluginRoot(
  entry: Pick<PluginsListEntry, "name" | "source" | "installedFrom">,
): Promise<string | undefined> {
  const tag = parseSourceTag(entry.source);
  if (!tag) return undefined;

  if (tag.kind === "marketplace") {
    const installed = await getConfigJsonInstalledPlugins();
    const match = installed.find(
      (p) => p.name === entry.name && p.marketplace === tag.name,
    );
    return match?.cache_path;
  }

  // live-marketplace: installedFrom is the marketplace's own root directory.
  if (!entry.installedFrom) return undefined;
  const plugins = await getLiveMarketplaceManifest(entry.installedFrom);
  const match = plugins.find((p) => p.name === entry.name);
  if (!match?.source) return undefined;
  return resolve(entry.installedFrom, match.source);
}

/** Test-only hook to reset in-process caches between scans. */
export function _resetPluginRootCaches(): void {
  installedPluginsCache = null;
  marketplaceManifestCache.clear();
}
