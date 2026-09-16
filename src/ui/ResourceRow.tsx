"use client";

import Link from "next/link";
import type { ResolvedNode } from "@/core/types";
import { KindIcon } from "./KindIcon";
import { Toggle } from "./Toggle";
import { Badge } from "./Badge";

/** Why a row's toggle cannot be operated, or null when it can. */
export function lockReason(node: ResolvedNode): string | null {
  if (node.controllable.type === "readonly") return node.controllable.reason;
  if (node.effectiveReason.type === "disabledByParent") {
    return "Disabled because the plugin that provides it is disabled.";
  }
  return null;
}

export interface ResourceRowProps {
  node: ResolvedNode;
  href?: string;
  onToggle?: (enabled: boolean) => void;
  /** Extra muted text after the description, e.g. "4 tools" or the parent MCP. */
  meta?: string;
  last?: boolean;
}

export function ResourceRow({
  node,
  href,
  onToggle,
  meta,
  last,
}: ResourceRowProps) {
  const locked = lockReason(node);
  const dimmed = locked !== null || !node.effectiveEnabled;
  const viaProxy =
    node.controllable.type === "mcpToolFilter" &&
    node.controllable.writable === "proxy-required";

  const inner = (
    <div
      className="row-hover"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        borderBottom: last ? "none" : "1px solid var(--border)",
        minHeight: 62,
        transition: "background 80ms ease",
      }}
    >
      <KindIcon kind={node.id.kind} muted={dimmed} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: dimmed ? "var(--text-secondary)" : "var(--text)",
            }}
          >
            {node.displayName}
          </span>
          {node.version && (
            <span
              style={{
                fontSize: "var(--font-size-sm)",
                color: "var(--text-muted)",
              }}
            >
              {node.version}
            </span>
          )}
          {viaProxy && (
            <Badge
              tone="muted"
              title="This tool lives in a plugin-declared MCP server, so the filter only takes effect once the proxy is running."
            >
              via proxy
            </Badge>
          )}
          {node.overridden && <Badge tone="info">overridden</Badge>}
        </div>

        {node.description && (
          <p
            title={node.description}
            style={{
              margin: "2px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.description}
          </p>
        )}

        {meta && (
          <p
            style={{
              margin: "2px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-muted)",
            }}
          >
            {meta}
          </p>
        )}
      </div>

      <span
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        style={{ display: "inline-flex" }}
      >
        <Toggle
          checked={node.effectiveEnabled}
          disabled={locked !== null || !onToggle}
          title={locked ?? undefined}
          aria-label={`Toggle ${node.displayName}`}
          onChange={onToggle}
        />
      </span>

      {href ? (
        <svg
          aria-hidden
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      ) : (
        <span aria-hidden style={{ width: 16, flexShrink: 0 }} />
      )}
    </div>
  );

  return href ? (
    <Link href={href} style={{ display: "block" }}>
      {inner}
    </Link>
  ) : (
    inner
  );
}
