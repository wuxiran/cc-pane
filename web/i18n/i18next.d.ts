import type { resources, defaultNS } from "./index";
import type forkReview from "./locales/zh-CN/forkReview.json";
import type taskVerification from "./locales/zh-CN/taskVerification.json";
import type review from "./locales/zh-CN/review.json";
import type browserTools from "./locales/zh-CN/browserTools.json";
import type browserAnnotations from "./locales/zh-CN/browserAnnotations.json";
import type workbenchTabs from "./locales/zh-CN/workbenchTabs.json";
import type newTabPage from "./locales/zh-CN/newTabPage.json";
import type sessionBind from "./locales/zh-CN/sessionBind.json";
import type tabContextMenu from "./locales/zh-CN/tabContextMenu.json";
import type codexIntegration from "./locales/zh-CN/codexIntegration.json";
import type island from "./locales/zh-CN/island.json";

type BaseResources = (typeof resources)["zh-CN"];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: Omit<BaseResources, "panes" | "orchestration" | "review" | "browserTools"> & {
      panes: BaseResources["panes"] & typeof forkReview & typeof newTabPage & typeof sessionBind & typeof tabContextMenu;
      orchestration: BaseResources["orchestration"] & typeof taskVerification;
      review: BaseResources["review"] & typeof review;
      browserTools: BaseResources["browserTools"] & typeof browserTools;
      workbenchTabs: typeof workbenchTabs;
      browserAnnotations: typeof browserAnnotations;
      codexIntegration: typeof codexIntegration;
      island: typeof island;
    };
  }
}
