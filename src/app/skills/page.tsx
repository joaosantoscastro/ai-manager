"use client";

import { ResourceBrowser } from "@/ui/ResourceBrowser";
import { UploadAction } from "@/ui/UploadAction";

const SCOPE_LABEL: Record<string, string> = {
  user: "User scope",
  plugin: "From a plugin",
  repository: "Repository scope",
  unknown: "Unresolved source",
};

export default function SkillsPage() {
  return (
    <ResourceBrowser
      kinds={["skill"]}
      title="Skills"
      subtitle="Manage the skills Copilot can load."
      titleAction={<UploadAction kind="skill" />}
      searchPlaceholder="Search skills…"
      listLabel="Installed"
      filters={["scope", "status"]}
      metaFor={(n) => SCOPE_LABEL[n.id.scope] ?? n.id.scope}
      empty={{
        title: "No skills found",
        lines: [
          "The Copilot configuration does not expose any skills in this scope.",
        ],
      }}
    />
  );
}
