import { ProvidersPanel } from "@/components/providers";
import type { ProviderTopView } from "@/components/providers/ProviderPagesHeader";
import ScopeBanner from "./ScopeBanner";

interface ProviderSectionProps {
  view: ProviderTopView;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function ProviderSection({ view, onDirtyChange }: ProviderSectionProps) {
  // 作用域徽标：profiles（启动配置层）与 providers（全局凭据层）互相跳转（批 5）
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {view === "profiles" ? (
        <ScopeBanner
          scope="profile"
          descriptionKey="scope.profileDesc"
          link={{ labelKey: "scope.manageCredentials", paneId: "provider-credentials" }}
        />
      ) : (
        <ScopeBanner
          scope="global"
          descriptionKey="scope.credentialsDesc"
          link={{ labelKey: "scope.manageProfiles", paneId: "provider" }}
        />
      )}
      <div className="min-h-0 flex-1">
        <ProvidersPanel key={view} compact view={view} onDirtyChange={onDirtyChange} />
      </div>
    </div>
  );
}
