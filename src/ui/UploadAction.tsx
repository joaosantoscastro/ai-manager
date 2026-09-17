"use client";

import { useState } from "react";
import { Button } from "./Button";
import { PlusIcon } from "./icons";
import { UploadModal } from "./UploadModal";
import type { UploadKind } from "@/core/uploads";

const LABEL: Record<UploadKind, string> = {
  skill: "Add a skill",
  agent: "Add an agent",
  hook: "Add hooks",
  mcp: "Add an MCP server",
};

/**
 * The `(+)` on a list page's title line, and the modal it opens.
 *
 * Both live in one component so a page only has to say which kind it is.
 * The modal being a child of the button is not a layout problem: `Modal`
 * portals to `document.body`, so it is only a parent in the React tree.
 */
export function UploadAction({ kind }: { kind: UploadKind }) {
  const [open, setOpen] = useState(false);
  const label = LABEL[kind];

  return (
    <>
      <Button
        size="iconOnly"
        ariaLabel={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
      </Button>
      <UploadModal open={open} onClose={() => setOpen(false)} kind={kind} />
    </>
  );
}
