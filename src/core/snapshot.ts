/**
 * Snapshot/restore for Copilot config files the app writes to. Every write
 * in `core/emit.ts` is preceded by a snapshot of the current file contents,
 * so `apply` is always reversible from the UI without touching git or
 * asking the user to remember what changed.
 */
import { mkdir, readFile, writeFile, readdir, lstat, chmod } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getSnapshotsDir } from "./state";

export interface SnapshotManifestEntry {
  id: string;
  createdAt: string;
  files: { path: string; snapshotFile: string; existed: boolean }[];
  note?: string;
}

function snapshotIdFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * The exact shape `snapshotIdFor` produces, e.g. `2026-09-16T10-24-02-019Z`.
 *
 * A snapshot id arrives from the browser (`POST /api/revert`), and it used to
 * be joined straight onto the snapshots directory. `../` in that value walked
 * out of the directory, so any attacker-supplied `manifest.json` elsewhere on
 * disk could be loaded — and a manifest names both the file to write and the
 * content to write into it. That made the route an arbitrary file write.
 *
 * Matching the generated format exactly is the cheapest complete fix: it
 * admits no separator, no `.` and no `..`, so nothing can escape.
 */
const SNAPSHOT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(id);
}

/** True when `child` is `parent` itself or sits somewhere beneath it. */
function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base + sep);
}

/**
 * Resolves a snapshot's directory, or `undefined` when `id` is not one this
 * module generated. Validating the format *and* re-checking containment is
 * deliberate belt-and-braces: the pattern already excludes traversal, and the
 * containment check means a future change to the pattern cannot silently
 * reintroduce it.
 */
function snapshotDirFor(id: string): string | undefined {
  if (!isValidSnapshotId(id)) return undefined;
  const root = getSnapshotsDir();
  const dir = join(root, id);
  if (!isInside(root, dir)) return undefined;
  return dir;
}

/**
 * Snapshots the current contents of each given absolute file path into
 * `~/.ai-setup-manager/snapshots/<id>/`, alongside a manifest recording
 * which original path each captured file corresponds to. Missing files are
 * recorded as `existed: false` so restore can recreate "the file didn't
 * exist yet" correctly.
 */
export async function createSnapshot(
  filePaths: string[],
  note?: string,
): Promise<SnapshotManifestEntry> {
  const id = snapshotIdFor(new Date());
  const dir = join(getSnapshotsDir(), id);
  await mkdir(dir, { recursive: true });
  // Snapshots contain whole copies of the user's config, including any
  // secrets it holds, so the tree is kept private to the account.
  await chmod(getSnapshotsDir(), 0o700).catch(() => {});
  await chmod(dir, 0o700).catch(() => {});

  const files: SnapshotManifestEntry["files"] = [];
  for (let i = 0; i < filePaths.length; i++) {
    const path = filePaths[i];
    const snapshotFile = join(dir, `file-${i}.snapshot`);
    try {
      const contents = await readFile(path, "utf8");
      await writeFile(snapshotFile, contents, "utf8");
      files.push({ path, snapshotFile, existed: true });
    } catch {
      files.push({ path, snapshotFile, existed: false });
    }
  }

  const manifest: SnapshotManifestEntry = {
    id,
    createdAt: new Date().toISOString(),
    files,
    note,
  };
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

export async function listSnapshots(): Promise<SnapshotManifestEntry[]> {
  const root = getSnapshotsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: SnapshotManifestEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Anything not matching the generated id shape was not written by
    // `createSnapshot`, so it is not offered as something to restore.
    if (!isValidSnapshotId(entry.name)) continue;
    try {
      const raw = await readFile(
        join(root, entry.name, "manifest.json"),
        "utf8",
      );
      manifests.push(JSON.parse(raw));
    } catch {
      // ignore corrupt/partial snapshot dirs
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshot(
  id: string,
): Promise<SnapshotManifestEntry | undefined> {
  const dir = snapshotDirFor(id);
  if (!dir) return undefined;
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Restores every file captured in a snapshot back to its captured content.
 * Files that did not exist at snapshot time are left untouched rather than
 * deleted, to avoid destructive surprises — a follow-up manual cleanup is
 * safer than an automatic delete of a file the user may have since edited.
 *
 * Two guards apply to every entry, because a manifest names both a
 * destination and a source and neither is re-derived at restore time:
 *
 *  - The captured content must come from inside this snapshot's own
 *    directory, so a manifest can never read some unrelated file and copy it
 *    somewhere else.
 *  - The destination must not be a symlink. Restoring through one would
 *    follow it to a target the snapshot never captured, which is the classic
 *    way a writable path is turned into a write somewhere privileged.
 */
export async function restoreSnapshot(
  id: string,
): Promise<{ restored: string[]; skipped: string[] }> {
  const dir = snapshotDirFor(id);
  const manifest = dir ? await getSnapshot(id) : undefined;
  if (!dir || !manifest) throw new Error(`No such snapshot: ${id}`);
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const file of manifest.files) {
    if (!file.existed) {
      skipped.push(file.path);
      continue;
    }
    if (!isInside(dir, file.snapshotFile)) {
      skipped.push(file.path);
      continue;
    }
    const link = await lstat(file.path).catch(() => null);
    if (link?.isSymbolicLink()) {
      skipped.push(file.path);
      continue;
    }
    const contents = await readFile(file.snapshotFile, "utf8");
    await writeFile(file.path, contents, "utf8");
    restored.push(file.path);
  }
  return { restored, skipped };
}
