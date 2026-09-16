import { McpDetail } from "@/ui/McpDetail";

export default async function McpDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <McpDetail nodeKey={decodeURIComponent(name)} />;
}
