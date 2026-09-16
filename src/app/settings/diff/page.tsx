"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Breadcrumb } from "@/ui/Breadcrumb";
import { DiffView } from "@/ui/DiffView";
import { usePendingDiff } from "@/ui/usePendingDiff";

export default function DiffPage() {
  const router = useRouter();
  const { diff, busy, loadingDiff, message, loadDiff, apply } =
    usePendingDiff();

  useEffect(() => {
    // The plan is read once, on arrival. Nothing on this page changes the
    // pending set, so there is no reason to re-read it.
    void loadDiff();
  }, [loadDiff]);

  return (
    <div>
      <Breadcrumb
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Review changes" },
        ]}
      />
      <DiffView
        diff={diff}
        busy={busy}
        loading={loadingDiff}
        onCancel={() => router.push("/settings")}
        onApply={() => {
          void apply().then((ok) => {
            if (ok) router.push("/settings");
          });
        }}
      />
      {message && (
        <p
          style={{
            marginTop: 14,
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {message}
        </p>
      )}
    </div>
  );
}
