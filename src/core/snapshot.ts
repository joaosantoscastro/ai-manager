/**
 * Snapshot/restore for Copilot config files the app writes to. Every write
 * in `core/emit.ts` is preceded by a snapshot of the current file contents,
 * so `apply` is always reversible from the UI without touching git or
 * asking the user to remember what changed.
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  try {
    const raw = await readFile(
      join(getSnapshotsDir(), id, "manifest.json"),
      "utf8",
    );
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
 */
export async function restoreSnapshot(
  id: string,
): Promise<{ restored: string[]; skipped: string[] }> {
  const manifest = await getSnapshot(id);
  if (!manifest) throw new Error(`No such snapshot: ${id}`);
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const file of manifest.files) {
    if (!file.existed) {
      skipped.push(file.path);
      continue;
    }
    const contents = await readFile(file.snapshotFile, "utf8");
    await writeFile(file.path, contents, "utf8");
    restored.push(file.path);
  }
  return { restored, skipped };
}
