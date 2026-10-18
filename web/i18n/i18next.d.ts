import type { resources, defaultNS } from "./index";
import type forkReview from "./locales/zh-CN/forkReview.json";
import type taskVerification from "./locales/zh-CN/taskVerification.json";

type BaseResources = (typeof resources)["zh-CN"];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: Omit<BaseResources, "panes" | "orchestration"> & {
      panes: BaseResources["panes"] & typeof forkReview;
      orchestration: BaseResources["orchestration"] & typeof taskVerification;
    };
  }
}
