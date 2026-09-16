"use client";

import { ResourceBrowser } from "@/ui/ResourceBrowser";
import { UpdatePluginsButton } from "@/ui/UpdatePluginsButton";
import { useGraph } from "@/ui/useGraph";

/** Installed plugins. Opening one shows everything it contributes. */
export default function PluginsPage() {
  const { refresh } = useGraph({ kind: ["plugin"] });

  return (
    <ResourceBrowser
      kinds={["plugin"]}
      title="Plugins"
      subtitle="Manage the Copilot plugins installed on this machine."
      searchPlaceholder="Search plugins…"
      listLabel="Installed"
      filters={["status"]}
      hrefFor={(n) => `/plugins/${encodeURIComponent(n.id.name)}`}
      headerAction={<UpdatePluginsButton onUpdated={() => void refresh()} />}
      empty={{
        title: "No plugins found",
        lines: [
          "The Copilot configuration on this machine does not list any installed plugins.",
        ],
      }}
    />
  );
}
