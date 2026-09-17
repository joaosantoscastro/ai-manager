"use client";

import { useEffect } from "react";
import { ResourceBrowser } from "@/ui/ResourceBrowser";
import { UploadAction } from "@/ui/UploadAction";
import { useSetupState } from "@/ui/SetupState";
import { nodeKey } from "@/core/types";

const SCOPE_LABEL: Record<string, string> = {
  user: "User scope",
  plugin: "From a plugin",
  repository: "Repository scope",
};

/** Cross-cutting view of every MCP server, from both user scope and plugins. */
export default function McpPage() {
  const { loadAllTools } = useSetupState();

  useEffect(() => {
    // Opening this page fills in every server whose tools are still
    // unknown, so the counts below are real rather than "not read yet".
    // The state service runs this once per session and the route skips any
    // server already cached, so returning here costs nothing.
    void loadAllTools();
  }, [loadAllTools]);

  return (
    <ResourceBrowser
      kinds={["mcp"]}
      title="MCP"
      subtitle="Manage Model Context Protocol servers."
      titleAction={<UploadAction kind="mcp" />}
      searchPlaceholder="Search MCP servers…"
      listLabel="Configured"
      filters={["scope", "status"]}
      hrefFor={(n) => `/mcp/${encodeURIComponent(nodeKey(n.id))}`}
      metaFor={(n) => {
        const scope = SCOPE_LABEL[n.id.scope] ?? n.id.scope;
        const tools = n.provides.filter((c) => c.kind === "tool").length;
        // Servers with no explicit `tools[]` allowlist expose everything
        // they have, so the real count is only known once the server itself
        // has answered.
        return tools > 0
          ? `${scope} · ${tools} tool${tools === 1 ? "" : "s"} listed`
          : `${scope} · reading tools…`;
      }}
      empty={{
        title: "No MCP servers found",
        lines: [
          "The Copilot configuration does not currently expose any MCP servers in this scope.",
        ],
      }}
    />
  );
}
