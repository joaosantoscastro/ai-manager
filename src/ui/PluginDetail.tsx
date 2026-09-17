"use client";

import { useMemo, useState } from "react";
import type { Kind, ResolvedNode } from "@/core/types";
import { nodeKey } from "@/core/types";
import { useGraph } from "./useGraph";
import { Breadcrumb } from "./Breadcrumb";
import { DetailHeader, SubTabs } from "./DetailChrome";
import { AboutTab } from "./DetailTabs";
import { ResourceList } from "./ResourceList";
import { LoadingLine } from "./Spinner";
import { ListHeading } from "./PageHeader";
import { EmptyState } from "./EmptyState";
import { UpdatePluginsButton } from "./UpdatePluginsButton";

const TABS = [
  { id: "provides", label: "Provides" },
  { id: "about", label: "About" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const KIND_SECTION: Partial<Record<Kind, string>> = {
  mcp: "MCP servers",
  skill: "Skills",
  agent: "Agents",
  hook: "Hooks",
  command: "Commands",
  instruction: "Instructions",
};

const KIND_ORDER: Kind[] = [
  "mcp",
  "skill",
  "agent",
  "hook",
  "command",
  "instruction",
];

/** Detail screen for a plugin: everything it contributes, plus its own metadata. */
export function PluginDetail({ name }: { name: string }) {
  const { data, loading, error, toggle, refresh } = useGraph({});
  const [tab, setTab] = useState<TabId>("provides");

  const targetKey = `plugin:user:${name}`;

  const node = useMemo(
    () => data?.nodes.find((n) => nodeKey(n.id) === targetKey),
    [data, targetKey],
  );

  const children = useMemo(
    () =>
      (data?.nodes ?? []).filter(
        (n) => n.providedBy && nodeKey(n.providedBy) === targetKey,
      ),
    [data, targetKey],
  );

  const grouped = useMemo(() => {
    const map = new Map<Kind, ResolvedNode[]>();
    for (const child of children) {
      const list = map.get(child.id.kind) ?? [];
      list.push(child);
      map.set(child.id.kind, list);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({
      kind: k,
      label: KIND_SECTION[k] ?? k,
      nodes: map.get(k)!,
    }));
  }, [children]);

  if (loading) {
    return <LoadingLine />;
  }

  if (error || !node) {
    return (
      <>
        <Breadcrumb
          items={[{ label: "Plugins", href: "/plugins" }, { label: name }]}
        />
        <EmptyState
          title={error ? "Could not read the local setup" : "Plugin not found"}
          lines={
            error
              ? [error]
              : [
                  `No plugin named "${name}" is present in the discovered configuration.`,
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
        items={[
          { label: "Plugins", href: "/plugins" },
          { label: node.displayName },
        ]}
        action={
          <UpdatePluginsButton
            name={node.id.name}
            onUpdated={() => void refresh()}
          />
        }
      />

      <DetailHeader
        node={node}
        onToggle={(enabled) => toggle(node.id, enabled)}
      />

      <SubTabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "provides" &&
        (grouped.length === 0 ? (
          <EmptyState
            title="This plugin contributes nothing"
            lines={[
              "It declares no MCP servers, skills, agents or hooks that this app can see.",
            ]}
          />
        ) : (
          grouped.map((group) => (
            <div key={group.kind} style={{ marginBottom: 22 }}>
              <ListHeading label={group.label} count={group.nodes.length} />
              <ResourceList
                nodes={group.nodes}
                hrefFor={(n) =>
                  n.id.kind === "mcp"
                    ? `/mcp/${encodeURIComponent(nodeKey(n.id))}`
                    : undefined
                }
                onToggle={(child, enabled) => toggle(child.id, enabled)}
              />
            </div>
          ))
        ))}

      {tab === "about" && <AboutTab node={node} childCount={children.length} />}
    </div>
  );
}
