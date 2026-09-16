"use client";

import { ResourceBrowser } from "@/ui/ResourceBrowser";

const SCOPE_LABEL: Record<string, string> = {
  user: "User scope",
  plugin: "From a plugin",
  repository: "Repository scope",
};

/**
 * Agents are read-only. Copilot has no `disabledAgents` setting, so there is
 * nothing this app could write to turn one off. The toggles are rendered
 * disabled rather than hidden so the real state stays visible.
 */
export default function AgentsPage() {
  return (
    <ResourceBrowser
      kinds={["agent"]}
      title="Agents"
      subtitle="View the agents available to Copilot."
      searchPlaceholder="Search agents…"
      listLabel="Available"
      filters={["scope"]}
      notice={
        <>
          <strong style={{ fontWeight: 600 }}>
            Agents cannot be disabled individually by Copilot.
          </strong>{" "}
          Copilot offers no setting to turn a single agent off, so these
          controls are read-only. Disabling the plugin that provides an agent
          does remove it.
        </>
      }
      metaFor={(n) => SCOPE_LABEL[n.id.scope] ?? n.id.scope}
      empty={{
        title: "No agents found",
        lines: [
          "The Copilot configuration does not expose any agents in this scope.",
        ],
      }}
    />
  );
}
