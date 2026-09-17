"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { useSetupState } from "./SetupState";
import {
  parseUpload,
  formatBytes,
  base64Bytes,
  type ExistingNames,
  type ParsedUpload,
  type UploadFile,
  type UploadKind,
} from "@/core/uploads";

const COPY: Record<
  UploadKind,
  {
    title: string;
    description: string;
    accept: string;
    /** Whether the browse button should ask for a folder. */
    directory: boolean;
    hint: string;
  }
> = {
  skill: {
    title: "Add a skill",
    description:
      "A skill is a folder containing SKILL.md. Drop the folder here, or a single .md file to become one.",
    accept: ".md,.markdown,text/markdown",
    directory: true,
    hint: "Saved to ~/.copilot/skills/",
  },
  agent: {
    title: "Add an agent",
    description: "An agent is a single markdown file.",
    accept: ".md,.markdown,text/markdown",
    directory: false,
    hint: "Saved to ~/.copilot/agents/",
  },
  hook: {
    title: "Add hooks",
    description:
      "A JSON file of hook entries keyed by event, for example { \"preToolUse\": [ … ] }.",
    accept: ".json,application/json",
    directory: false,
    hint: "Merged into ~/.copilot/settings.json",
  },
  mcp: {
    title: "Add an MCP server",
    description:
      "A JSON file with an mcpServers object, or a single server definition.",
    accept: ".json,application/json",
    directory: false,
    hint: "Merged into ~/.copilot/mcp-config.json",
  },
};

/** The parts of the File System Entry API this needs, typed rather than `any`. */
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FsFileEntry extends FsEntry {
  file(onSuccess: (file: File) => void, onError: (err: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader(): {
    readEntries(
      onSuccess: (entries: FsEntry[]) => void,
      onError: (err: unknown) => void,
    ): void;
  };
}

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Chunked: spreading a large array into String.fromCharCode blows the
  // argument limit somewhere around a hundred thousand entries.
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** `readEntries` yields at most 100 at a time, so it has to be drained. */
function readAllEntries(
  reader: ReturnType<FsDirectoryEntry["createReader"]>,
): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FsEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function collectEntry(
  entry: FsEntry,
  prefix: string,
): Promise<{ path: string; file: File }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FsFileEntry).file(resolve, reject),
    );
    return [{ path: `${prefix}${entry.name}`, file }];
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(
      (entry as FsDirectoryEntry).createReader(),
    );
    const collected = await Promise.all(
      children.map((child) => collectEntry(child, `${prefix}${entry.name}/`)),
    );
    return collected.flat();
  }
  return [];
}

interface Dropped {
  rootName: string;
  files: { path: string; file: File }[];
}

/**
 * Turns a drop into a root name plus paths relative to that root.
 *
 * A single dropped directory is the root itself, so its own name is stripped
 * from every path — a skill folder yields `SKILL.md`, not
 * `my-skill/SKILL.md`, which is what the destination needs.
 */
async function readDrop(items: DataTransferItemList): Promise<Dropped | null> {
  const entries: FsEntry[] = [];
  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry() as FsEntry | null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return null;

  if (entries.length === 1 && entries[0].isDirectory) {
    const root = entries[0];
    const children = await readAllEntries(
      (root as FsDirectoryEntry).createReader(),
    );
    const collected = await Promise.all(
      children.map((child) => collectEntry(child, "")),
    );
    return { rootName: root.name, files: collected.flat() };
  }

  const collected = await Promise.all(
    entries.map((entry) => collectEntry(entry, "")),
  );
  const files = collected.flat();
  return { rootName: stripExtension(files[0]?.file.name ?? "upload"), files };
}

function stripExtension(name: string): string {
  return name.replace(/\.agent\.md$/i, "").replace(/\.[^.]+$/, "");
}

/** The `<input>` fallback reports `a/b/c.md` in `webkitRelativePath`. */
function readPicked(fileList: FileList): Dropped | null {
  const files = Array.from(fileList);
  if (files.length === 0) return null;

  const relative = files[0].webkitRelativePath;
  if (relative && relative.includes("/")) {
    const rootName = relative.split("/")[0];
    return {
      rootName,
      files: files.map((file) => ({
        path: file.webkitRelativePath.split("/").slice(1).join("/"),
        file,
      })),
    };
  }
  return {
    rootName: stripExtension(files[0].name),
    files: files.map((file) => ({ path: file.name, file })),
  };
}

/**
 * The drop zone behind every tab's `(+)`.
 *
 * Everything here happens in the browser: files are read, checked with the
 * same `parseUpload` the server will run again, and put in the pending set.
 * Nothing reaches disk until the user applies, exactly like a toggle.
 */
export function UploadModal({
  open,
  onClose,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  kind: UploadKind;
}) {
  const { nodes, addUploads } = useSetupState();
  const copy = COPY[kind];

  const [files, setFiles] = useState<UploadFile[]>([]);
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [replace, setReplace] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only user scope can collide: a plugin's skill lives inside the plugin,
  // and an upload never writes there.
  const existing = useMemo<ExistingNames>(() => {
    const named = (k: string) =>
      nodes
        .filter((n) => n.id.kind === k && n.id.scope === "user")
        .map((n) => n.id.name);
    return {
      skills: named("skill"),
      agents: named("agent"),
      mcpServers: named("mcp"),
      // Hook entries cannot be reconstructed from the graph, so duplicate
      // detection is left to the server, which reads settings.json directly.
      hooks: {},
    };
  }, [nodes]);

  const reset = useCallback(() => {
    setFiles([]);
    setParsed(null);
    setReplace(false);
    setReadError(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const accept = useCallback(
    async (dropped: Dropped | null) => {
      if (!dropped || dropped.files.length === 0) {
        setReadError("Nothing readable was dropped.");
        return;
      }
      setReading(true);
      setReadError(null);
      try {
        const encoded: UploadFile[] = await Promise.all(
          dropped.files.map(async ({ path, file }) => ({
            path,
            contentBase64: await toBase64(file),
          })),
        );
        setFiles(encoded);
        setReplace(false);
        setParsed(parseUpload(kind, dropped.rootName, encoded, existing));
      } catch (err) {
        setReadError(err instanceof Error ? err.message : String(err));
      } finally {
        setReading(false);
      }
    },
    [kind, existing],
  );

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const confirm = useCallback(() => {
    if (!parsed) return;
    addUploads([
      {
        id: newId(),
        kind,
        name: parsed.name,
        // The exact bytes that were parsed, so the server's re-check sees
        // the same input and cannot reach a different conclusion.
        files: parsed.kind === "skill" ? normalizeSkill(files) : files,
        replace,
      },
    ]);
    close();
  }, [parsed, addUploads, kind, files, replace, close]);

  const blocked =
    !parsed ||
    parsed.errors.length > 0 ||
    (parsed.collisions.length > 0 && !replace);

  const totalBytes = files.reduce(
    (sum, file) => sum + base64Bytes(file.contentBase64),
    0,
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={copy.title}
      description={copy.description}
      width={560}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={blocked}>
            Add to pending
          </Button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept={copy.accept}
        multiple={copy.directory}
        // Not in React's HTML typings, but every Chromium build the app runs
        // on supports it, and it is the only way to pick a folder.
        {...(copy.directory ? { webkitdirectory: "" } : {})}
        style={{ display: "none" }}
        onChange={(event) => {
          const list = event.target.files;
          if (list) void accept(readPicked(list));
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void handleDrop(event.dataTransfer, accept);
        }}
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: 132,
          padding: 20,
          borderRadius: "var(--radius-md)",
          border: `1px dashed ${dragOver ? "var(--primary)" : "var(--border-strong)"}`,
          background: dragOver ? "var(--surface-subtle)" : "transparent",
          color: "var(--text-secondary)",
          fontSize: "var(--font-size-sm)",
          cursor: "pointer",
          textAlign: "center",
        }}
      >
        {reading ? (
          <>
            <Spinner size={18} label="Reading files" />
            <span>Reading…</span>
          </>
        ) : (
          <>
            <span style={{ color: "var(--text)", fontWeight: 500 }}>
              {copy.directory
                ? "Drop a folder or file here"
                : "Drop a file here"}
            </span>
            <span>or click to browse</span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {copy.hint}
            </span>
          </>
        )}
      </button>

      {readError && <Problem tone="error">{readError}</Problem>}

      {parsed && !reading && (
        <div style={{ marginTop: 14 }}>
          <Summary
            parsed={parsed}
            fileCount={files.length}
            totalBytes={totalBytes}
          />

          {parsed.errors.map((message) => (
            <Problem key={message} tone="error">
              {message}
            </Problem>
          ))}
          {parsed.notes.map((message) => (
            <Problem key={message} tone="note">
              {message}
            </Problem>
          ))}

          {parsed.collisions.length > 0 && parsed.errors.length === 0 && (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--warning)",
                background: "var(--surface-subtle)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => setReplace(event.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong style={{ fontWeight: 600 }}>
                  {parsed.collisions.join(", ")}
                </strong>{" "}
                already exists. Replace it. The current version is snapshotted
                first, so Settings can restore it.
              </span>
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * A lone markdown file dropped as a skill is stored as `SKILL.md`, and the
 * server re-derives that the same way. Renaming it here keeps the bytes the
 * browser validated and the bytes the server receives identical.
 */
function normalizeSkill(files: UploadFile[]): UploadFile[] {
  if (files.length !== 1) return files;
  if (files[0].path === "SKILL.md") return files;
  if (!/\.md$/i.test(files[0].path)) return files;
  return [{ path: "SKILL.md", contentBase64: files[0].contentBase64 }];
}

/** Kept out of the drop handler so the async read is not tied to the event. */
async function handleDrop(
  transfer: DataTransfer,
  handle: (dropped: Dropped | null) => Promise<void>,
): Promise<void> {
  const dropped = await readDrop(transfer.items);
  await handle(dropped);
}

function Summary({
  parsed,
  fileCount,
  totalBytes,
}: {
  parsed: ParsedUpload;
  fileCount: number;
  totalBytes: number;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-subtle)",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <div style={{ fontWeight: 600 }}>{parsed.name}</div>
      <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
        {fileCount} file{fileCount === 1 ? "" : "s"} · {formatBytes(totalBytes)}
      </div>
      {parsed.destinations.length > 0 && (
        <ul
          style={{
            margin: "8px 0 0",
            padding: 0,
            listStyle: "none",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          {parsed.destinations.slice(0, 8).map((destination) => (
            <li key={destination}>~/.copilot/{destination}</li>
          ))}
          {parsed.destinations.length > 8 && (
            <li>+{parsed.destinations.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Problem({
  tone,
  children,
}: {
  tone: "error" | "note";
  children: React.ReactNode;
}) {
  return (
    <p
      style={{
        margin: "8px 0 0",
        fontSize: "var(--font-size-sm)",
        color:
          tone === "error" ? "var(--danger)" : "var(--text-secondary)",
      }}
    >
      {children}
    </p>
  );
}
