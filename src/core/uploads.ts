/**
 * Uploading a skill, agent, hook or MCP server.
 *
 * This module is deliberately isomorphic: no `node:fs`, no `node:os`, no
 * dependencies. The browser needs it to tell the user what a dropped folder
 * would do *before* anything is pending, and the server needs the identical
 * rules to check the request again. Sharing one implementation is the only
 * way those two answers can be guaranteed to agree.
 *
 * Nothing here touches the filesystem. Destinations are paths relative to
 * `~/.copilot`; resolving them against a real directory is `emit.ts`'s job.
 */

export type UploadKind = "skill" | "agent" | "hook" | "mcp";

export const UPLOAD_KINDS: readonly UploadKind[] = [
  "skill",
  "agent",
  "hook",
  "mcp",
];

/** One file from the drop, path relative to whatever root was dropped. */
export interface UploadFile {
  /** POSIX separators, e.g. `SKILL.md` or `references/labels.md`. */
  path: string;
  /** Raw bytes, base64. Skills may legitimately contain images. */
  contentBase64: string;
}

/** An upload waiting in the pending set, exactly as it crosses the wire. */
export interface PendingUpload {
  id: string;
  kind: UploadKind;
  /** The dropped root's name, used when nothing better can be derived. */
  name: string;
  files: UploadFile[];
  /** Set only by an explicit confirmation in the modal. */
  replace: boolean;
}

/** What already exists, so a collision can be spotted without disk access. */
export interface ExistingNames {
  skills: string[];
  agents: string[];
  mcpServers: string[];
  /** Existing user hook entries, `event` -> entries, to spot duplicates. */
  hooks: Record<string, unknown[]>;
}

export const EMPTY_EXISTING: ExistingNames = {
  skills: [],
  agents: [],
  mcpServers: [],
  hooks: {},
};

/** The result of reading an upload: what it would do, and why it might not. */
export interface ParsedUpload {
  kind: UploadKind;
  name: string;
  /** Paths relative to `~/.copilot` this upload writes to or merges into. */
  destinations: string[];
  /** Existing names this would overwrite. Requires `replace` to proceed. */
  collisions: string[];
  /** Worth saying, but not a reason to stop. */
  notes: string[];
  /** Any entry here means the upload cannot be accepted. */
  errors: string[];
  /** `skill`/`agent`: destination path relative to `~/.copilot` -> base64. */
  writes: Record<string, string>;
  /** `mcp`: server name -> config. `hook`: event -> entries to append. */
  merge: Record<string, unknown>;
}

// Caps. Generous for text, low enough that base64 in a JSON request body
// stays reasonable. Raising these should mean switching to multipart rather
// than moving the numbers.
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_NAME_LENGTH = 64;

/**
 * Names become a directory or a filename under `~/.copilot`, so they are held
 * to what is safe on every platform this app runs on, not to what the
 * filesystem would tolerate.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  return SAFE_NAME.test(name);
}

/**
 * Rejects anything that could escape the destination directory. A dropped
 * folder is user data, and a relative path in user data is still untrusted
 * input by the time it reaches the server.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path !== path.trim()) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  // A Windows drive letter or a URL scheme.
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && !/^\s|\s$/.test(segment),
  );
}

/**
 * Editor and OS droppings. Skipped rather than rejected: a folder dragged
 * from Finder almost always carries a `.DS_Store`, and failing the whole
 * upload over one would be useless pedantry.
 */
export function shouldSkipPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (segment) =>
        segment === ".DS_Store" ||
        segment === "Thumbs.db" ||
        segment === "__MACOSX" ||
        segment === ".git" ||
        segment.startsWith("._"),
    );
}

/** Byte count of base64 without decoding it. */
export function base64Bytes(contentBase64: string): number {
  const clean = contentBase64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

/** Decodes base64 to text in either runtime. */
export function decodeUtf8(contentBase64: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(contentBase64, "base64").toString("utf8");
  }
  const binary = atob(contentBase64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Pulls `name:` out of YAML frontmatter.
 *
 * Hand-rolled on purpose. `gray-matter` is already a dependency but it reads
 * from `fs` at import time, so it cannot be bundled into the browser, and the
 * one field needed here does not justify splitting this module in two.
 */
export function frontmatterName(text: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return undefined;
  const line = /^name:[ \t]*(.+)$/m.exec(block[1]);
  if (!line) return undefined;
  const value = line[1].trim().replace(/^["']|["']$/g, "").trim();
  return value || undefined;
}

/** Strips `.agent.md` or `.md`, then any directory part. */
function agentStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "");
}

function fileStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function blank(kind: UploadKind, name: string): ParsedUpload {
  return {
    kind,
    name,
    destinations: [],
    collisions: [],
    notes: [],
    errors: [],
    writes: {},
    merge: {},
  };
}

/**
 * Reads an upload and works out exactly what it would do.
 *
 * Always returns a result — an unusable upload comes back with `errors`
 * filled in rather than throwing, because the modal needs to show every
 * problem at once instead of the first one.
 */
export function parseUpload(
  kind: UploadKind,
  rootName: string,
  rawFiles: UploadFile[],
  existing: ExistingNames = EMPTY_EXISTING,
): ParsedUpload {
  const result = blank(kind, rootName);

  const files = rawFiles.filter((f) => !shouldSkipPath(f.path));
  const skipped = rawFiles.length - files.length;
  if (skipped > 0) {
    result.notes.push(
      `${skipped} system file${skipped === 1 ? "" : "s"} ignored.`,
    );
  }

  if (files.length === 0) {
    result.errors.push("No usable files were found.");
    return result;
  }
  if (files.length > MAX_FILES) {
    result.errors.push(
      `Too many files (${files.length}). The limit is ${MAX_FILES}.`,
    );
    return result;
  }

  let total = 0;
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      result.errors.push(`Unsafe path: ${file.path}`);
      continue;
    }
    const size = base64Bytes(file.contentBase64);
    total += size;
    if (size > MAX_FILE_BYTES) {
      result.errors.push(
        `${file.path} is ${formatBytes(size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`,
      );
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    result.errors.push(
      `Upload is ${formatBytes(total)}; the limit is ${formatBytes(MAX_TOTAL_BYTES)}.`,
    );
  }
  if (result.errors.length > 0) return result;

  const unwrapped = stripCommonRoot(files);
  if (unwrapped.root) result.name = unwrapped.root;

  switch (kind) {
    case "skill":
      return parseSkill(result, unwrapped.files, existing);
    case "agent":
      return parseAgent(result, unwrapped.files, existing);
    case "hook":
      return parseHook(result, unwrapped.files, existing);
    case "mcp":
      return parseMcp(result, unwrapped.files, existing);
  }
}

/**
 * Drops a single shared top-level directory from every path.
 *
 * The modal already strips the dropped folder's own name, so a skill arrives
 * as `SKILL.md`. A folder that wraps another folder would otherwise arrive as
 * `my-skill/SKILL.md` and be rejected for having no top-level `SKILL.md`,
 * which is a confusing way to say "you dropped one level too high". Stripping
 * only happens when *every* file agrees on the same first segment, so a real
 * skill (`SKILL.md` plus `references/`) is never touched.
 */
function stripCommonRoot(files: UploadFile[]): {
  root: string | null;
  files: UploadFile[];
} {
  const first = files[0]?.path.split("/")[0];
  if (!first || !files.every((f) => f.path.startsWith(`${first}/`))) {
    return { root: null, files };
  }
  return {
    root: isSafeName(first) ? first : null,
    files: files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })),
  };
}

/**
 * A skill is a directory containing `SKILL.md`. A lone markdown file is
 * accepted too and becomes that `SKILL.md`, since dragging one file in is the
 * obvious thing to try.
 */
function parseSkill(
  result: ParsedUpload,
  files: UploadFile[],
  existing: ExistingNames,
): ParsedUpload {
  let entry = files.find((f) => f.path === "SKILL.md");
  let normalized = files;

  if (!entry) {
    const markdown = files.filter((f) => /\.md$/i.test(f.path));
    if (files.length === 1 && markdown.length === 1) {
      entry = { path: "SKILL.md", contentBase64: markdown[0].contentBase64 };
      normalized = [entry];
      result.notes.push(`${files[0].path} will be saved as SKILL.md.`);
    } else {
      result.errors.push(
        "A skill needs a SKILL.md file at the top of the dropped folder.",
      );
      return result;
    }
  }

  const declared = frontmatterName(decodeUtf8(entry.contentBase64));
  const name = declared ?? result.name;
  if (!isSafeName(name)) {
    result.errors.push(
      `"${name}" cannot be used as a folder name. Use letters, digits, dots, dashes or underscores.`,
    );
    return result;
  }
  result.name = name;
  if (declared && declared !== result.name) {
    result.notes.push(`Named "${declared}" by its frontmatter.`);
  }

  for (const file of normalized) {
    result.writes[`skills/${name}/${file.path}`] = file.contentBase64;
  }
  result.destinations = Object.keys(result.writes);
  if (existing.skills.includes(name)) result.collisions.push(name);
  return result;
}

/** An agent is one markdown file, saved as `agents/<name>.agent.md`. */
function parseAgent(
  result: ParsedUpload,
  files: UploadFile[],
  existing: ExistingNames,
): ParsedUpload {
  const markdown = files.filter((f) => /\.md$/i.test(f.path));
  if (markdown.length !== 1 || files.length !== 1) {
    result.errors.push("An agent must be a single .md file.");
    return result;
  }

  const file = markdown[0];
  const declared = frontmatterName(decodeUtf8(file.contentBase64));
  const name = declared ?? agentStem(file.path);
  if (!isSafeName(name)) {
    result.errors.push(
      `"${name}" cannot be used as a file name. Use letters, digits, dots, dashes or underscores.`,
    );
    return result;
  }
  result.name = name;
  if (declared) result.notes.push(`Named "${declared}" by its frontmatter.`);

  result.writes[`agents/${name}.agent.md`] = file.contentBase64;
  result.destinations = [`agents/${name}.agent.md`];
  if (existing.agents.includes(name)) result.collisions.push(name);
  return result;
}

function readJsonFile(
  result: ParsedUpload,
  files: UploadFile[],
  what: string,
): Record<string, unknown> | null {
  if (files.length !== 1 || !/\.json$/i.test(files[0].path)) {
    result.errors.push(`A ${what} must be a single .json file.`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(files[0].contentBase64));
  } catch {
    result.errors.push(`${files[0].path} is not valid JSON.`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    result.errors.push(`${files[0].path} must contain a JSON object.`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * User hooks have no file of their own — they live in `settings.json` under
 * `hooks.<event>[]`. So an upload is a merge, and the only sensible unit is
 * an `event -> entries` map. Event keys are left exactly as written: both
 * `preToolUse` and `PreToolUse` occur in the wild and the scanner already
 * copes with either, so validating against a fixed list would reject
 * perfectly good hooks.
 */
function parseHook(
  result: ParsedUpload,
  files: UploadFile[],
  existing: ExistingNames,
): ParsedUpload {
  const doc = readJsonFile(result, files, "hook");
  if (!doc) return result;

  const wrapped = doc.hooks;
  const source =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : doc;

  const merge: Record<string, unknown[]> = {};
  let duplicates = 0;
  let added = 0;

  for (const [event, value] of Object.entries(source)) {
    if (!Array.isArray(value)) {
      result.errors.push(`"${event}" must be an array of hook entries.`);
      continue;
    }
    if (value.length === 0) continue;
    const entries: unknown[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        result.errors.push(`An entry under "${event}" is not an object.`);
        continue;
      }
      const already = (existing.hooks[event] ?? []).some(
        (other) => JSON.stringify(other) === JSON.stringify(item),
      );
      if (already) {
        duplicates += 1;
        continue;
      }
      entries.push(item);
      added += 1;
    }
    if (entries.length > 0) merge[event] = entries;
  }

  if (result.errors.length > 0) return result;
  if (added === 0) {
    result.errors.push(
      duplicates > 0
        ? "Every hook in this file is already in your settings."
        : "No hook entries were found in this file.",
    );
    return result;
  }
  if (duplicates > 0) {
    result.notes.push(
      `${duplicates} entr${duplicates === 1 ? "y is" : "ies are"} already present and will not be added again.`,
    );
  }

  result.name = fileStem(files[0].path);
  result.merge = merge;
  result.destinations = ["settings.json"];
  // Hooks are appended to an event's array, so there is no name to overwrite
  // and nothing to confirm. Duplicates are simply not added twice.
  result.notes.push(
    `Adds ${added} entr${added === 1 ? "y" : "ies"} to ${Object.keys(merge).join(", ")}.`,
  );
  return result;
}

/**
 * An MCP upload merges into `mcp-config.json`'s `mcpServers`. Accepts a full
 * config file, or a bare single-server object named after the file.
 */
function parseMcp(
  result: ParsedUpload,
  files: UploadFile[],
  existing: ExistingNames,
): ParsedUpload {
  const doc = readJsonFile(result, files, "MCP server");
  if (!doc) return result;

  const wrapped = doc.mcpServers;
  let servers: Record<string, unknown>;

  if (
    typeof wrapped === "object" &&
    wrapped !== null &&
    !Array.isArray(wrapped)
  ) {
    servers = wrapped as Record<string, unknown>;
  } else if (
    typeof doc.command === "string" ||
    typeof doc.url === "string" ||
    typeof doc.type === "string"
  ) {
    servers = { [fileStem(files[0].path)]: doc };
  } else {
    result.errors.push(
      'Expected an "mcpServers" object, or a single server with a "command", "url" or "type".',
    );
    return result;
  }

  const names = Object.keys(servers);
  if (names.length === 0) {
    result.errors.push("No MCP servers were found in this file.");
    return result;
  }

  for (const name of names) {
    if (!isSafeName(name)) {
      result.errors.push(`"${name}" is not a usable server name.`);
      continue;
    }
    const config = servers[name];
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      result.errors.push(`"${name}" must be a JSON object.`);
      continue;
    }
    const shape = config as Record<string, unknown>;
    if (
      typeof shape.command !== "string" &&
      typeof shape.url !== "string" &&
      typeof shape.type !== "string"
    ) {
      result.errors.push(`"${name}" needs a "command", "url" or "type".`);
      continue;
    }
    result.merge[name] = config;
    if (existing.mcpServers.includes(name)) result.collisions.push(name);
  }

  if (result.errors.length > 0) return result;
  result.name = names.length === 1 ? names[0] : `${names.length} servers`;
  result.destinations = ["mcp-config.json"];
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validates the wire shape of `{ uploads }` on a request body. Same contract
 * as `parseOverrideMap`: `null` means the body was wrong, an empty array
 * means there was nothing to do.
 */
export function parseUploadList(input: unknown): PendingUpload[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_FILES) return null;

  const uploads: PendingUpload[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const { id, kind, name, files, replace } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !id) return null;
    if (typeof name !== "string" || !name) return null;
    if (typeof replace !== "boolean") return null;
    if (typeof kind !== "string" || !UPLOAD_KINDS.includes(kind as UploadKind))
      return null;
    if (!Array.isArray(files) || files.length === 0) return null;

    const parsedFiles: UploadFile[] = [];
    for (const file of files) {
      if (typeof file !== "object" || file === null || Array.isArray(file))
        return null;
      const { path, contentBase64 } = file as Record<string, unknown>;
      if (typeof path !== "string" || typeof contentBase64 !== "string")
        return null;
      parsedFiles.push({ path, contentBase64 });
    }

    uploads.push({
      id,
      kind: kind as UploadKind,
      name,
      files: parsedFiles,
      replace,
    });
  }
  return uploads;
}
