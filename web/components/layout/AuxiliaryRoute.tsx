import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { lazyWithRetry } from "@/lib/lazyRetry";

const LayoutSwitcherWindow = lazyWithRetry(
  () => import("@/components/LayoutSwitcherWindow"), "LayoutSwitcherWindow",
);
const MobilePrototypeRoute = lazyWithRetry(
  () => import("./MobilePrototypeRoute"), "MobilePrototypeRoute",
);

/** Auxiliary window code is fetched only by the window that needs it. */
export default function AuxiliaryRoute({ mode }: { mode: "layout-switcher" | "mobile-prototype" }) {
  const { t } = useTranslation("common");
  return (
    <Suspense fallback={<div role="status">{t("loading")}</div>}>
      {mode === "layout-switcher" ? <LayoutSwitcherWindow /> : <MobilePrototypeRoute />}
    </Suspense>
  );
}
