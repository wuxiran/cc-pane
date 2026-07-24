import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

interface SettingsSearchContextValue {
  query: string;
  matchedSectionIds: ReadonlySet<string>;
  highlightedSectionId: string | null;
}

const SettingsSearchContext = createContext<SettingsSearchContextValue>({
  query: "",
  matchedSectionIds: new Set(),
  highlightedSectionId: null,
});

export const SettingsSearchProvider = SettingsSearchContext.Provider;

interface SearchableSettingProps {
  sectionId: string;
  children: ReactElement<{ className?: string }>;
}

export function SearchableSetting({ sectionId, children }: SearchableSettingProps) {
  const { query, matchedSectionIds, highlightedSectionId } = useContext(SettingsSearchContext);
  if (query && !matchedSectionIds.has(sectionId)) return null;
  if (!isValidElement(children)) return null;
  const highlighted = highlightedSectionId === sectionId;
  return cloneElement(children, {
    "data-settings-section": sectionId,
    "data-settings-highlighted": highlighted ? "true" : undefined,
    className: cn(
      children.props.className,
      "scroll-m-8 rounded-md transition-[box-shadow,background-color] duration-[var(--dur)]",
      highlighted && "bg-[var(--app-active-bg)] ring-2 ring-[var(--app-accent)] ring-offset-2 ring-offset-[var(--app-content)]",
    ),
  } as Partial<typeof children.props>);
}

export function scrollToSettingsSection(sectionId: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-settings-section]")]
        .find((element) => element.dataset.settingsSection === sectionId);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}
