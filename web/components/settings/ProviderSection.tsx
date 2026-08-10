import { ProvidersPanel } from "@/components/providers";
import type { ProviderTopView } from "@/components/providers/ProviderPagesHeader";

interface ProviderSectionProps {
  view: ProviderTopView;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function ProviderSection({ view, onDirtyChange }: ProviderSectionProps) {
  return <ProvidersPanel key={view} compact view={view} onDirtyChange={onDirtyChange} />;
}
