/**
 * Atomic file writes: write to a temp file in the destination's own
 * directory, then rename over the target.
 *
 * Rename is the only way to replace a file's contents without ever exposing
 * a half-written state. A plain `writeFile` truncates first and fills after,
 * so a crash — or a reader arriving mid-write — sees a truncated file. That
 * matters here because the files being replaced are the user's Copilot
 * configuration, and a truncated `settings.json` silently disables their
 * whole setup.
 *
 * The temp file is deliberately created beside the destination rather than
 * in the system temp dir: `rename` is only atomic within a single
 * filesystem, and `~/.copilot` may well sit on a different one from `/tmp`.
 */
import {
  chmod,
  lstat,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /**
   * Mode for the written file. Defaults to the mode the destination already
   * has, so replacing a file never changes its permissions — `settings.json`
   * ships as 0600 and `mcp-config.json` as 0644, and forcing either to a
   * single fixed value would be a silent permission change.
   */
  mode?: number;
  /** Mode applied to the parent directory after it is created. */
  dirMode?: number;
}

/**
 * Thrown when the destination is a symlink.
 *
 * Writing through one follows it to a target the caller never named, which
 * is the standard way a writable path is turned into a write somewhere it
 * should not reach. `core/snapshot.ts` already refuses to restore through a
 * symlink; this keeps the write path consistent with it.
 */
export class SymlinkWriteError extends Error {
  constructor(path: string) {
    super(`Refusing to write through a symlink: ${path}`);
    this.name = "SymlinkWriteError";
  }
}

/**
 * `contents` takes bytes as well as text because an uploaded skill folder may
 * legitimately carry an image alongside its `SKILL.md`, and encoding those
 * bytes as UTF-8 would corrupt them.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // `mkdir`'s mode is masked by the umask, so it is set explicitly when the
  // caller cares (the state directory holds OAuth tokens and config copies).
  if (options.dirMode !== undefined) {
    await chmod(dir, options.dirMode).catch(() => {});
  }

  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) throw new SymlinkWriteError(path);

  const mode =
    options.mode ?? (existing?.isFile() ? existing.mode & 0o777 : undefined);

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (typeof contents === "string") {
      await writeFile(tmpPath, contents, "utf8");
    } else {
      await writeFile(tmpPath, contents);
    }
    // Applied before the rename, so the file never exists at the destination
    // with the wrong permissions, not even briefly.
    if (mode !== undefined) {
      await chmod(tmpPath, mode).catch(() => {
        // Non-fatal: some filesystems (network shares, certain sandboxes)
        // reject chmod outright. The contents are still correct.
      });
    }
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Convenience wrapper for the JSON files this app writes. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", options);
}
