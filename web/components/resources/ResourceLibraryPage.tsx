// 资源库主区：按子页切换内容。
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import ComponentsLibraryPage from "./ComponentsLibraryPage";
import McpLibraryPage from "./McpLibraryPage";
import SkillsLibraryPage from "./SkillsLibraryPage";

export default function ResourceLibraryPage() {
  const section = useResourceLibraryStore((s) => s.section);
  if (section === "skills") return <SkillsLibraryPage />;
  if (section === "components") return <ComponentsLibraryPage />;
  return <McpLibraryPage />;
}
