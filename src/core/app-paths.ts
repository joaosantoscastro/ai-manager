/**
 * Where the app's own files live, which differs between a repo checkout and
 * an installed desktop build.
 *
 * In the packaged app the Next server is `.next/standalone/server.js` forked
 * from Electron's resources directory, so `process.cwd()` is no longer the
 * repo root and cannot be used to locate anything the app ships. Electron's
 * main process sets `PLUGIN_MANAGER_RESOURCES` before forking the server, and
 * that variable is the single signal both modes read.
 */
import { join } from "node:path";

const RESOURCES_ENV = "PLUGIN_MANAGER_RESOURCES";

/** True when running inside the packaged desktop app. */
export function isPackaged(): boolean {
  return Boolean(process.env[RESOURCES_ENV]);
}

/**
 * Root of the app's shipped files: Electron's resources directory when
 * packaged, the repo root in development.
 */
export function getResourcesDir(): string {
  return process.env[RESOURCES_ENV] || process.cwd();
}

/**
 * The precompiled MCP proxy entry point. Only meaningful when packaged —
 * in development the proxy is run from TypeScript source instead.
 */
export function getPackagedProxyBin(): string {
  return join(getResourcesDir(), "proxy", "bin.js");
}

/** The proxy entry point in TypeScript source form, for development runs. */
export function getSourceProxyBin(): string {
  return join(getResourcesDir(), "src", "proxy", "bin.ts");
}

/**
 * Path to the executable that can run the packaged proxy as a plain Node
 * script. Electron's main process publishes its own binary path here, because
 * that binary doubles as a Node runtime under `ELECTRON_RUN_AS_NODE=1` and is
 * the only runtime the app can be sure exists on the user's machine.
 */
export function getPackagedNodeRuntime(): string | undefined {
  return process.env.PLUGIN_MANAGER_NODE_RUNTIME || undefined;
}
