import { ProvidersPanel } from "@/components/providers";
import type { ProviderTopView } from "@/components/providers/ProviderPagesHeader";

interface ProviderSectionProps {
  view: ProviderTopView;
}

export default function ProviderSection({ view }: ProviderSectionProps) {
  return <ProvidersPanel key={view} compact view={view} />;
}
