"use client";

import type { ResolvedNode } from "@/core/types";
import { nodeKey } from "@/core/types";
import { ResourceRow } from "./ResourceRow";

/** Bordered card holding rows separated by 1px dividers. Depth comes from the border, not a shadow. */
export function ResourceList({
  nodes,
  hrefFor,
  metaFor,
  onToggle,
}: {
  nodes: ResolvedNode[];
  hrefFor?: (node: ResolvedNode) => string | undefined;
  metaFor?: (node: ResolvedNode) => string | undefined;
  onToggle?: (node: ResolvedNode, enabled: boolean) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {nodes.map((node, i) => (
        <ResourceRow
          key={nodeKey(node.id)}
          node={node}
          href={hrefFor?.(node)}
          meta={metaFor?.(node)}
          last={i === nodes.length - 1}
          onToggle={onToggle ? (enabled) => onToggle(node, enabled) : undefined}
        />
      ))}
    </div>
  );
}
