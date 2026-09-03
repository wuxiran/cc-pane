import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DramaEpisode, DramaProject } from "@/types/drama";
import DramaSidebar from "./DramaSidebar";

const projects = [
  { id: "d1", title: "都市夜行" },
  { id: "d2", title: "山海志" },
] as DramaProject[];
const episodes = [
  { id: "e1", ordinal: 0, title: "序章" },
  { id: "e2", ordinal: 1, title: "追逐" },
] as DramaEpisode[];

describe("DramaSidebar", () => {
  it("列出项目；选中项目后列出分集，点击回传 id", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    const onSelectEpisode = vi.fn();
    const onCreateProject = vi.fn();
    const onCreateEpisode = vi.fn();
    render(
      <DramaSidebar
        projects={projects}
        selectedDramaId="d1"
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        episodes={episodes}
        selectedEpisodeId="e1"
        onSelectEpisode={onSelectEpisode}
        onCreateEpisode={onCreateEpisode}
      />,
    );
    await user.click(screen.getByText("山海志"));
    expect(onSelectProject).toHaveBeenCalledWith("d2");
    await user.click(screen.getByText(/追逐/));
    expect(onSelectEpisode).toHaveBeenCalledWith("e2");

    const [newProject, newEpisode] = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-label"));
    await user.click(newProject);
    await user.click(newEpisode);
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(onCreateEpisode).toHaveBeenCalledTimes(1);
  });

  it("没选中项目时不渲染分集区", () => {
    render(
      <DramaSidebar
        projects={projects}
        selectedDramaId={null}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        episodes={episodes}
        selectedEpisodeId={null}
        onSelectEpisode={vi.fn()}
        onCreateEpisode={vi.fn()}
      />,
    );
    expect(screen.queryByText(/序章/)).not.toBeInTheDocument();
  });
});
