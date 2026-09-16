/**
 * MCP proxy — the fallback for filtering tools on a *plugin-declared*
 * server. Shadowing (adding a same-named user-scope entry) was proven not
 * to work (see spike-shadow) and has a nasty side effect of silently
 * persisting the server into `disabledMcpServers`. So instead, when a
 * plugin-scope MCP server has some of its tools disabled, `core/emit.ts`
 * rewrites *that server's own declaration* to launch this proxy instead of
 * the real upstream, passing the real upstream config + an allowlist as
 * argv. The proxy is transparent for everything except `tools/list`
 * (filtered) and `tools/call` (blocked for disallowed tools).
 *
 * Trade-off (documented in the plan): the proxy has to rewrite the file
 * that declares the server (the plugin's own `.mcp.json`), because there is
 * no user-scope override point that reliably wins. That file is always
 * snapshotted first so it can be restored exactly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServerConfig } from "@/core/tool-loader";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const METHOD_NOT_FOUND = -32601;

export interface ProxyOptions {
  upstream: McpServerConfig;
  /** null means "no allowlist configured" — pass everything through unfiltered. */
  allowedTools: Set<string> | null;
  write: (line: string) => void;
  onExit?: (code: number) => void;
}

function isStdioUpstream(
  u: McpServerConfig,
): u is Extract<McpServerConfig, { type: "stdio" | "local" }> {
  return u.type === "stdio" || u.type === "local";
}

function filterToolsListResult(
  result: unknown,
  allowed: Set<string> | null,
): unknown {
  if (!allowed) return result;
  const typed = result as { tools?: { name: string }[] } | undefined;
  if (!typed?.tools) return result;
  return { ...typed, tools: typed.tools.filter((t) => allowed.has(t.name)) };
}

/** Stdio-upstream proxy: spawns the real server lazily and pipes messages bidirectionally. */
class StdioProxy {
  private child: ChildProcess | null = null;
  private pending = new Map<number | string, string>(); // id -> original method, so tools/list responses can be filtered

  constructor(
    private opts: ProxyOptions & {
      upstream: Extract<McpServerConfig, { type: "stdio" | "local" }>;
    },
  ) {}

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const { command, args, env } = this.opts.upstream;
    const child = spawn(command, args ?? [], {
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"] as const,
    });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleUpstreamLine(line));
    child.on("exit", (code) => this.opts.onExit?.(code ?? 0));
    this.child = child;
    return child;
  }

  private handleUpstreamLine(line: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.write(line);
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const method = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (method === "tools/list" && msg.result) {
        msg.result = filterToolsListResult(msg.result, this.opts.allowedTools);
      }
    }
    this.opts.write(JSON.stringify(msg));
  }

  handleClientLine(line: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.method === "tools/call" && this.opts.allowedTools) {
      const toolName = (msg.params as { name?: string } | undefined)?.name;
      if (toolName && !this.opts.allowedTools.has(toolName)) {
        this.opts.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Tool "${toolName}" is disabled.`,
            },
          }),
        );
        return;
      }
    }

    if (msg.id !== undefined && msg.method)
      this.pending.set(msg.id, msg.method);
    const child = this.ensureChild();
    child.stdin?.write(JSON.stringify(msg) + "\n");
  }

  close() {
    this.child?.kill();
  }
}

/** Http-upstream proxy: each JSON-RPC line becomes one POST; no persistent process. */
class HttpProxy {
  constructor(
    private opts: ProxyOptions & {
      upstream: Extract<McpServerConfig, { type: "http" | "sse" }>;
    },
  ) {}

  async handleClientLine(line: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.method === "tools/call" && this.opts.allowedTools) {
      const toolName = (msg.params as { name?: string } | undefined)?.name;
      if (toolName && !this.opts.allowedTools.has(toolName)) {
        this.opts.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Tool "${toolName}" is disabled.`,
            },
          }),
        );
        return;
      }
    }

    const { url, headers } = this.opts.upstream;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify(msg),
    });
    const text = await res.text();
    const jsonLine =
      text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("{")) ?? text;
    let responseMsg: JsonRpcMessage;
    try {
      responseMsg = JSON.parse(jsonLine);
    } catch {
      this.opts.write(text);
      return;
    }
    if (msg.method === "tools/list" && responseMsg.result) {
      responseMsg.result = filterToolsListResult(
        responseMsg.result,
        this.opts.allowedTools,
      );
    }
    this.opts.write(JSON.stringify(responseMsg));
  }

  close() {
    // no persistent connection to close
  }
}

export function createProxy(opts: ProxyOptions): {
  handleClientLine: (line: string) => Promise<void> | void;
  close: () => void;
} {
  if (isStdioUpstream(opts.upstream)) {
    const proxy = new StdioProxy({ ...opts, upstream: opts.upstream });
    return {
      handleClientLine: (line) => proxy.handleClientLine(line),
      close: () => proxy.close(),
    };
  }
  const proxy = new HttpProxy({ ...opts, upstream: opts.upstream });
  return {
    handleClientLine: (line) => proxy.handleClientLine(line),
    close: () => proxy.close(),
  };
}
