/**
 * Zod schemas for the JSON emitted by the Copilot CLI.
 *
 * These are intentionally permissive (`.passthrough()` / optional fields)
 * because the CLI's JSON shape is not a documented, versioned contract.
 * Validation failures should degrade to a warning, not a crash — see
 * `adapters/copilot/cli.ts`.
 *
 * Shapes verified against Copilot CLI 1.0.83 and 1.0.85:
 *   - `copilot plugins list --json`
 *   - `copilot mcp list --json`
 *   - `copilot skill list --json`
 */
import { z } from "zod";

export const pluginsListScopeSchema = z.enum([
  "user",
  "session",
  "repository",
  "working-directory",
  "organization",
  "plugin",
  "builtin",
  "unknown",
]);

export const pluginsListKindSchema = z.enum([
  "plugin",
  "mcp",
  "skill",
  "instruction",
  "lsp",
]);

export const pluginsListEntrySchema = z
  .object({
    kind: pluginsListKindSchema,
    name: z.string(),
    scope: pluginsListScopeSchema,
    source: z.string().optional(),
    enabled: z.boolean().optional(),
    version: z.string().optional(),
    installedFrom: z.string().optional(),
    marketplace: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const pluginsListPayloadSchema = z.object({
  plugins: z.array(pluginsListEntrySchema),
  errors: z.array(z.unknown()).optional().default([]),
});

/**
 * Copilot CLI 1.0.85 returns a bare array of installed plugins. Earlier
 * versions returned the canonical `{ plugins: [...] }` payload. Normalize
 * the newer form here so downstream code keeps one stable contract.
 */
function normalizePluginsListOutput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;

  return {
    plugins: input.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }

      const plugin = item as Record<string, unknown>;
      const marketplace = plugin.marketplace;
      const hasMarketplace = typeof marketplace === "string";
      return {
        ...plugin,
        kind: "plugin",
        scope: hasMarketplace ? "user" : "unknown",
        source: hasMarketplace
          ? `marketplace:${marketplace}`
          : plugin.source,
      };
    }),
  };
}

export const pluginsListOutputSchema = z.preprocess(
  normalizePluginsListOutput,
  pluginsListPayloadSchema,
);

export const mcpServerEntrySchema = z
  .object({
    tools: z.array(z.string()).optional().default(["*"]),
    type: z.enum(["stdio", "local", "http", "sse"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    sourcePlugin: z.string().optional(),
    sourcePluginVersion: z.string().optional(),
    source: z.enum(["user", "plugin", "workspace", "builtin"]).optional(),
    enabled: z.boolean().optional().default(true),
  })
  .passthrough();

export const mcpListOutputSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerEntrySchema),
});

export const skillListEntrySchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string(),
    path: z.string().optional(),
    enabled: z.boolean().optional().default(true),
  })
  .passthrough();

export const skillListOutputSchema = z.array(skillListEntrySchema);

export type PluginsListEntry = z.infer<typeof pluginsListEntrySchema>;
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
export type SkillListEntry = z.infer<typeof skillListEntrySchema>;
