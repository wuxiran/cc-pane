import type { resources, defaultNS } from "./index";
import type forkReview from "./locales/zh-CN/forkReview.json";
import type taskVerification from "./locales/zh-CN/taskVerification.json";
import type review from "./locales/zh-CN/review.json";
import type browserTools from "./locales/zh-CN/browserTools.json";

type BaseResources = (typeof resources)["zh-CN"];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: Omit<BaseResources, "panes" | "orchestration" | "review" | "browserTools"> & {
      panes: BaseResources["panes"] & typeof forkReview;
      orchestration: BaseResources["orchestration"] & typeof taskVerification;
      review: BaseResources["review"] & typeof review;
      browserTools: BaseResources["browserTools"] & typeof browserTools;
    };
  }
}
