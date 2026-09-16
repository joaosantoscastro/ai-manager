/**
 * A GUI application launched from Finder or the Start menu inherits a minimal
 * `PATH` from the window manager, not the one the user configured in their
 * shell profile. This app shells out constantly — `npx` for MCP proxies, the
 * `copilot` CLI, and whatever command each MCP server declares — so without
 * this the packaged build fails to find tools that work fine in a terminal.
 *
 * The login shell is asked for its `PATH` once at startup and the result is
 * merged into this process's environment, which every child inherits.
 */
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

/**
 * Directories worth having even if the shell lookup fails, covering the
 * common install locations for Node, Homebrew and user-level npm prefixes.
 */
function fallbackDirs() {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
  ];
}

/**
 * Runs the user's login shell as an interactive login shell so profile files
 * are sourced, then reads back the `PATH` it produced.
 */
function readLoginShellPath(timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    // A marker is printed around the value because profile scripts routinely
    // write banners to stdout, which would otherwise be parsed as the PATH.
    const marker = "__PM_PATH__";
    const command = `printf '%s' "${marker}"; printf '%s' "$PATH"; printf '%s' "${marker}"`;

    execFile(
      shell,
      ["-ilc", command],
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return resolve(undefined);
        const parts = String(stdout).split(marker);
        // A well-formed run yields [before, value, after].
        if (parts.length < 3) return resolve(undefined);
        const value = parts[1].trim();
        resolve(value || undefined);
      },
    );
  });
}

function mergePath(...sources) {
  const separator = path.delimiter;
  const seen = new Set();
  const merged = [];

  for (const source of sources) {
    if (!source) continue;
    for (const entry of source.split(separator)) {
      const dir = entry.trim();
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      merged.push(dir);
    }
  }

  return merged.join(separator);
}

/**
 * Widens `process.env.PATH` using the login shell's PATH, falling back to a
 * fixed list of common directories. Safe to call more than once. Resolves to
 * the PATH that was applied.
 */
async function applyShellPath({ timeoutMs = 5000 } = {}) {
  // Windows GUI processes do inherit the system and user PATH, so the shell
  // round trip buys nothing there.
  const shellPath =
    process.platform === "win32"
      ? undefined
      : await readLoginShellPath(timeoutMs);

  const merged = mergePath(
    process.env.PATH,
    shellPath,
    fallbackDirs().join(path.delimiter),
  );

  process.env.PATH = merged;
  return merged;
}

module.exports = { applyShellPath, mergePath };
