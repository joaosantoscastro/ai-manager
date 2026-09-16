"use client";

import { ResourceBrowser } from "@/ui/ResourceBrowser";

/**
 * Copilot has no per-hook enable setting, so this app implements one: a
 * disabled hook is cut out of its file and kept in managed state, then put
 * back byte for byte when it is switched on again. `All hooks` is the one
 * real Copilot switch, and it changes no hook file at all.
 */
export default function HooksPage() {
  return (
    <ResourceBrowser
      kinds={["hook"]}
      title="Hooks"
      subtitle="Choose which hooks run around Copilot tool calls."
      searchPlaceholder="Search hooks…"
      listLabel="Registered"
      filters={["hookEvent", "scope", "status"]}
      metaFor={hookMeta}
      empty={{
        title: "No hooks found",
        lines: [
          "Nothing on this machine declares a hook.",
          "Hooks come from your user settings or from a plugin.",
        ],
      }}
    />
  );
}

function hookMeta(node: {
  id: { name: string };
  providedBy?: { name: string };
  controllable: { type: string };
}): string | undefined {
  if (node.controllable.type === "settingsAllHooksToggle") {
    return "Copilot setting · changes no hook file";
  }
  const owner = node.providedBy
    ? `Declared by ${node.providedBy.name}`
    : "Your settings.json";
  const event = node.id.name.split(":")[0];
  return `${event} · ${owner}`;
}
