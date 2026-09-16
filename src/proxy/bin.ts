#!/usr/bin/env node
/**
 * Entry point Copilot actually spawns instead of the real MCP server, once
 * `emit.ts` has rewritten a plugin's `.mcp.json` to point at this file.
 *
 * Usage:
 *   node bin.js --upstream '<json-encoded McpServerConfig>' --allow tool_a,tool_b
 *   node bin.js --upstream '<json>' --allow '*'   // pass every tool through
 *   node bin.js --upstream '<json>' --allow ''    // pass no tool through
 */
import { createInterface } from "node:readline";
import { createProxy } from "./server";
import type { McpServerConfig } from "@/core/tool-loader";

function parseArgs(argv: string[]): {
  upstream: McpServerConfig;
  allowedTools: Set<string> | null;
} {
  const upstreamIdx = argv.indexOf("--upstream");
  const allowIdx = argv.indexOf("--allow");
  if (upstreamIdx === -1 || !argv[upstreamIdx + 1]) {
    throw new Error("Missing required --upstream <json> argument");
  }
  const upstream = JSON.parse(argv[upstreamIdx + 1]) as McpServerConfig;
  // An absent `--allow` and an empty `--allow ''` mean opposite things, so
  // they must not collapse into the same value. No flag at all (or an
  // explicit `*`) is "unfiltered", represented as null. A flag that is
  // present but empty is a real, empty allowlist: nothing passes.
  const allowRaw = allowIdx === -1 ? undefined : argv[allowIdx + 1];
  const allowedTools =
    allowRaw === undefined || allowRaw === "*"
      ? null
      : new Set(allowRaw.split(",").filter(Boolean));
  return { upstream, allowedTools };
}

function main() {
  const { upstream, allowedTools } = parseArgs(process.argv.slice(2));
  const proxy = createProxy({
    upstream,
    allowedTools,
    write: (line) => process.stdout.write(line + "\n"),
    onExit: (code) => process.exit(code),
  });

  let inFlight = 0;
  let stdinClosed = false;
  const maybeExit = () => {
    if (stdinClosed && inFlight === 0) {
      proxy.close();
      process.exit(0);
    }
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    inFlight++;
    Promise.resolve(proxy.handleClientLine(line))
      .catch(() => {})
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  });
  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });

  process.on("SIGTERM", () => {
    proxy.close();
    process.exit(0);
  });
}

main();
