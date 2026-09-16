"use client";

import Link from "next/link";
import { useState } from "react";
import type { ResolvedNode } from "@/core/types";
import { Field } from "./Section";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { StatusDot } from "./DetailChrome";
import { isSecretKey, maskValue } from "./secrets";

const SCOPE_LABEL: Record<string, string> = {
  user: "User (~/.copilot)",
  plugin: "Plugin",
  repository: "Repository",
  builtin: "Built in",
  workspace: "Workspace",
  unknown: "Unresolved",
};

const CONTROL_LABEL: Record<string, string> = {
  settingsPluginToggle: "Written to settings.json → enabledPlugins",
  settingsMcpToggle: "Written to settings.json → disabledMcpServers",
  settingsSkillToggle: "Written to settings.json → disabledSkills",
  mcpToolFilter: "Written to the server's tools list",
  readonly: "Not controllable",
};

interface McpRaw {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: string[];
}

/** Environment variables and headers, with secret-looking values masked. */
function SecretTable({
  entries,
  title,
}: {
  entries: [string, string][];
  title: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const hasSecret = entries.some(([k]) => isSecretKey(k));

  if (entries.length === 0) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 600 }}>
          {title}
        </span>
        {hasSecret && (
          <Button size="sm" onClick={() => setRevealed((v) => !v)}>
            {revealed ? "Hide values" : "Reveal values"}
          </Button>
        )}
      </div>
      {entries.map(([key, value]) => {
        const secret = isSecretKey(key);
        return (
          <Field key={key} label={key} mono>
            {secret && !revealed ? (
              <span style={{ color: "var(--text-muted)" }}>
                {maskValue(value)}
              </span>
            ) : (
              value || <span style={{ color: "var(--text-muted)" }}>empty</span>
            )}
          </Field>
        );
      })}
      {hasSecret && !revealed && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          Values that look like credentials are hidden by default.
        </p>
      )}
    </div>
  );
}

/** Transport, command, arguments and environment for an MCP server. */
export function McpConfigurationTab({ node }: { node: ResolvedNode }) {
  const raw = (node.raw ?? {}) as McpRaw;
  const env = Object.entries(raw.env ?? {});
  const headers = Object.entries(raw.headers ?? {});

  return (
    <div>
      <Field label="Transport">{raw.type ?? "unknown"}</Field>
      {raw.command && (
        <Field label="Command" mono>
          {raw.command}
        </Field>
      )}
      {raw.args && raw.args.length > 0 && (
        <Field label="Arguments" mono>
          {raw.args.join(" ")}
        </Field>
      )}
      {raw.url && (
        <Field label="URL" mono>
          {raw.url}
        </Field>
      )}
      <Field label="Tools list">
        {raw.tools && raw.tools.length > 0
          ? `${raw.tools.length} listed`
          : "None — the server exposes everything it offers"}
      </Field>

      <SecretTable entries={env} title="Environment variables" />
      <SecretTable entries={headers} title="Headers" />
    </div>
  );
}

/** Source, scope, files, relations and control mode. Shared by all kinds. */
export function AboutTab({
  node,
  parent,
  childCount,
}: {
  node: ResolvedNode;
  parent?: ResolvedNode;
  childCount?: number;
}) {
  const reason =
    node.effectiveReason.type === "source"
      ? "Read from the source configuration"
      : node.effectiveReason.type === "overridden"
        ? "Overridden by you, not yet applied to disk"
        : "Disabled because the plugin that provides it is disabled";

  return (
    <div>
      <Field label="Status">
        <StatusDot enabled={node.effectiveEnabled} />
      </Field>
      <Field label="On disk">
        {node.sourceEnabled ? "Enabled" : "Disabled"}
      </Field>
      <Field label="Why">{reason}</Field>
      <Field label="Scope">{SCOPE_LABEL[node.id.scope] ?? node.id.scope}</Field>
      <Field label="Control">
        {CONTROL_LABEL[node.controllable.type] ?? node.controllable.type}
        {node.controllable.type === "mcpToolFilter" &&
          node.controllable.writable === "proxy-required" && (
            <>
              {" "}
              <Badge tone="muted">via proxy</Badge>
            </>
          )}
        {node.controllable.type === "readonly" && (
          <p
            style={{
              margin: "3px 0 0",
              color: "var(--text-secondary)",
            }}
          >
            {node.controllable.reason}
          </p>
        )}
      </Field>

      {parent && (
        <Field label="Provided by">
          {parent.id.kind === "plugin" ? (
            <Link
              href={`/plugins/${encodeURIComponent(parent.id.name)}`}
              style={{ color: "var(--primary)" }}
            >
              {parent.displayName}
            </Link>
          ) : (
            parent.displayName
          )}
        </Field>
      )}

      {childCount !== undefined && childCount > 0 && (
        <Field label="Provides">{childCount} item(s)</Field>
      )}

      {node.files.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: "var(--font-size-sm)",
              fontWeight: 600,
            }}
          >
            Files
          </p>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              color: "var(--text-secondary)",
            }}
          >
            {node.files.map((f) => (
              <li
                key={f}
                style={{
                  padding: "5px 0",
                  borderBottom: "1px solid var(--border)",
                  wordBreak: "break-all",
                }}
              >
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
