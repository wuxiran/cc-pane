// 资源库主区：按子页切换内容。
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import McpLibraryPage from "./McpLibraryPage";

export default function ResourceLibraryPage() {
  const section = useResourceLibraryStore((s) => s.section);
  return section === "mcp" ? <McpLibraryPage /> : null;
}
