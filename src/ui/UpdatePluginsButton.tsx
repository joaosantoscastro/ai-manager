"use client";

import { useState } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { RefreshIcon } from "./icons";
import { useToast } from "./Toast";

/**
 * Runs `copilot plugin update` — for one plugin when `name` is given, for
 * every installed plugin when it is not.
 *
 * Confirmed first, because this is one of the few actions in the app that
 * changes what is installed on the machine rather than which parts of it are
 * switched on. The result arrives as a toast; the CLI's own output is not
 * shown, since it is noisy and the interesting part is whether it worked.
 */
export function UpdatePluginsButton({
  name,
  onUpdated,
}: {
  name?: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  const label = name ? "Update" : "Update all";
  const subject = name ?? "all plugins";

  async function run() {
    setConfirming(false);
    setRunning(true);
    try {
      const res = await fetch("/api/plugins/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name ? { name } : {}),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!res.ok) {
        toast({
          tone: "error",
          message: `Could not update ${subject}. ${body?.error ?? `The request failed (${res.status}).`}`,
        });
        return;
      }

      toast({
        tone: "success",
        message: name ? `Updated ${name}.` : "Updated all plugins.",
      });
      onUpdated?.();
    } catch (err) {
      toast({
        tone: "error",
        message: `Could not update ${subject}. ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => setConfirming(true)}
        disabled={running}
        title={
          name
            ? `Run copilot plugin update ${name}`
            : "Run copilot plugin update --all"
        }
        minWidth={name ? 116 : 132}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            justifyContent: "center",
          }}
        >
          <RefreshIcon size={15} />
          {running ? "Updating…" : label}
        </span>
      </Button>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={name ? `Update ${name}?` : "Update all plugins?"}
        description={
          name
            ? `This runs "copilot plugin update ${name}" and installs the latest version on this machine.`
            : 'This runs "copilot plugin update --all" and installs the latest version of every installed plugin on this machine.'
        }
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void run()}>
              {label}
            </Button>
          </>
        }
      />
    </>
  );
}
