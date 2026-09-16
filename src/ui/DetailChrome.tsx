"use client";

import type { ResolvedNode } from "@/core/types";
import { KindIcon } from "./KindIcon";
import { Toggle } from "./Toggle";
import { Badge } from "./Badge";
import { lockReason } from "./ResourceRow";

/** The bordered identity card at the top of every detail screen. */
export function DetailHeader({
  node,
  onToggle,
}: {
  node: ResolvedNode;
  onToggle?: (enabled: boolean) => void;
}) {
  const locked = lockReason(node);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 16px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        background: "var(--surface)",
        marginBottom: 18,
      }}
    >
      <KindIcon kind={node.id.kind} muted={!node.effectiveEnabled} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: "var(--font-size-lg)", fontWeight: 600 }}>
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
          {node.overridden && <Badge tone="info">overridden</Badge>}
        </div>
        {node.description && (
          <p
            style={{
              margin: "3px 0 0",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-secondary)",
            }}
          >
            {node.description}
          </p>
        )}
        {locked && (
          <p
            style={{
              margin: "5px 0 0",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {locked}
          </p>
        )}
      </div>
      <Toggle
        checked={node.effectiveEnabled}
        disabled={locked !== null || !onToggle}
        title={locked ?? undefined}
        aria-label={`Toggle ${node.displayName}`}
        onChange={onToggle}
      />
    </div>
  );
}

/** `Tools | Configuration | About` sub-navigation inside a detail screen. */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 2,
        marginBottom: 18,
        borderBottom: "1px solid var(--border)",
        paddingBottom: 10,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid transparent",
              background: active ? "var(--surface-subtle)" : "transparent",
              color: active ? "var(--text)" : "var(--text-secondary)",
              fontSize: "var(--font-size-sm)",
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** `● Enabled` / `● Disabled` status pill used in the State section. */
export function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: enabled ? "var(--success)" : "var(--text-muted)",
        }}
      />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}
