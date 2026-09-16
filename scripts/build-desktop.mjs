/**
 * Assembles everything the desktop app ships into `build/resources`.
 *
 * electron-builder copies that directory verbatim into the app's resources,
 * so this script is the single place that decides what a user actually
 * downloads.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build as esbuild } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_DIR = path.join(ROOT, ".next");
const STANDALONE_DIR = path.join(NEXT_DIR, "standalone");
const RESOURCES_DIR = path.join(ROOT, "build", "resources");

/**
 * Everything the standalone server actually needs. Next.js copies other
 * root-level files into the output because they sit at the tracing root, so
 * an allowlist is used rather than a list of things to delete — a new file in
 * the repo root should never silently end up inside the installer.
 */
const KEEP = new Set([
  ".next",
  "node_modules",
  "public",
  "server.js",
  "package.json",
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

async function buildNext() {
  step("Building the Next.js app");
  await run("npx", ["next", "build"]);

  if (!existsSync(path.join(STANDALONE_DIR, "server.js"))) {
    throw new Error(
      'No standalone server was produced. Check that next.config.ts sets output: "standalone".',
    );
  }
}

/**
 * The standalone server serves `public/` and `.next/static` itself, but only
 * if they sit next to it. Next.js leaves that copy to the deployment step
 * because hosted deployments usually put both behind a CDN.
 */
async function collectStaticAssets() {
  step("Collecting static assets");
  await cp(path.join(ROOT, "public"), path.join(STANDALONE_DIR, "public"), {
    recursive: true,
  });
  await cp(
    path.join(NEXT_DIR, "static"),
    path.join(STANDALONE_DIR, ".next", "static"),
    { recursive: true },
  );
}

/**
 * Compiles the MCP proxy to a single self-contained script.
 *
 * Copilot spawns this long after the app has quit, so it cannot rely on
 * `npx`, a network connection, or a TypeScript loader being available.
 */
async function buildProxy() {
  step("Bundling the MCP proxy");
  await esbuild({
    entryPoints: [path.join(ROOT, "src", "proxy", "bin.ts")],
    outfile: path.join(RESOURCES_DIR, "proxy", "bin.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    alias: { "@": path.join(ROOT, "src") },
    logLevel: "warning",
  });
}

async function stageStandalone() {
  step("Staging the server payload");
  const destination = path.join(RESOURCES_DIR, "standalone");
  await cp(STANDALONE_DIR, destination, { recursive: true });

  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(destination)) {
    if (KEEP.has(entry)) continue;
    await rm(path.join(destination, entry), { recursive: true, force: true });
  }

  // The standalone bundle carries a package.json that still lists the app's
  // dependencies. Replacing it avoids any chance of a runtime resolving
  // against a manifest describing packages that were never copied.
  await writeFile(
    path.join(destination, "package.json"),
    `${JSON.stringify({ name: "plugin-manager-server", private: true, type: "commonjs" }, null, 2)}\n`,
  );
}

async function main() {
  await rm(RESOURCES_DIR, { recursive: true, force: true });
  await mkdir(RESOURCES_DIR, { recursive: true });

  await buildNext();
  await collectStaticAssets();
  await buildProxy();
  await stageStandalone();

  step(`Done. Payload ready at ${path.relative(ROOT, RESOURCES_DIR)}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
