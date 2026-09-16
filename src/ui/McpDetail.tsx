"use client";

import { useMemo, useState } from "react";
import type { ResolvedNode } from "@/core/types";
import { nodeKey } from "@/core/types";
import { useSetupState } from "./SetupState";
import { useGraph } from "./useGraph";
import { Breadcrumb } from "./Breadcrumb";
import { DetailHeader, SubTabs } from "./DetailChrome";
import { McpToolsTab } from "./McpToolsTab";
import { McpConfigurationTab, AboutTab } from "./DetailTabs";
import { EmptyState } from "./EmptyState";

const TABS = [
  { id: "tools", label: "Tools" },
  { id: "configuration", label: "Configuration" },
  { id: "about", label: "About" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function McpDetail({ nodeKey: targetKey }: { nodeKey: string }) {
  const { data, loading, error, toggle, refresh } = useGraph({});
  const { setManyEnabled } = useSetupState();
  const [tab, setTab] = useState<TabId>("tools");

  const node = useMemo(
    () => data?.nodes.find((n) => nodeKey(n.id) === targetKey),
    [data, targetKey],
  );

  const tools = useMemo(
    () =>
      (data?.nodes ?? []).filter(
        (n) => n.id.kind === "tool" && n.id.parentKey === targetKey,
      ),
    [data, targetKey],
  );

  const parent = useMemo(
    () =>
      node?.providedBy
        ? data?.nodes.find((n) => nodeKey(n.id) === nodeKey(node.providedBy!))
        : undefined,
    [data, node],
  );

  if (loading) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>
    );
  }

  if (error || !node) {
    return (
      <>
        <Breadcrumb items={[{ label: "MCP", href: "/mcp" }, { label: "—" }]} />
        <EmptyState
          title={error ? "Could not read the local setup" : "Server not found"}
          lines={
            error
              ? [error]
              : [
                  "This MCP server is no longer present in the discovered configuration.",
                  "It may have been removed since the last scan.",
                ]
          }
          actionLabel="Refresh discovery"
          onAction={() => refresh()}
        />
      </>
    );
  }

  return (
    <div>
      <Breadcrumb
        items={[{ label: "MCP", href: "/mcp" }, { label: node.displayName }]}
      />

      <DetailHeader
        node={node}
        onToggle={(enabled) => toggle(node.id, enabled)}
      />

      <SubTabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "tools" && (
        <McpToolsTab
          server={node}
          tools={tools}
          onToggle={(tool: ResolvedNode, enabled: boolean) => {
            toggle(tool.id, enabled);
          }}
          onToggleMany={(entries) => {
            setManyEnabled(
              entries.map(({ node: tool, enabled }) => ({
                id: tool.id,
                enabled,
              })),
            );
          }}
          onInventoryChanged={refresh}
        />
      )}
      {tab === "configuration" && <McpConfigurationTab node={node} />}
      {tab === "about" && (
        <AboutTab node={node} parent={parent} childCount={tools.length} />
      )}
    </div>
  );
}
