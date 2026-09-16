import { PluginDetail } from "@/ui/PluginDetail";

export default async function PluginDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <PluginDetail name={decodeURIComponent(name)} />;
}
