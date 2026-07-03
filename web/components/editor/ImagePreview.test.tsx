import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ImagePreview from "./ImagePreview";

// 非 Tauri 运行时走 /api/fs/raw 资源 URL，避免依赖 convertFileSrc
vi.mock("@/services/runtime", () => ({
  isTauriRuntime: () => false,
}));

vi.mock("@/services/filesystemService", () => ({
  filesystemService: {
    getEntryInfo: vi.fn(),
  },
}));

const { filesystemService } = await import("@/services/filesystemService");
const getEntryInfo = filesystemService.getEntryInfo as ReturnType<typeof vi.fn>;

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

const FILE = "/proj/assets/logo.png";

function loadImage(width = 200, height = 100) {
  const img = screen.getByRole("img") as HTMLImageElement;
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
  return img;
}

describe("ImagePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEntryInfo.mockResolvedValue({ size: 2048, modified: null });
  });

  it("uses the web raw-file endpoint outside Tauri", () => {
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toContain(`/api/fs/raw?path=${encodeURIComponent(FILE)}`);
  });

  it("shows format badge, natural size and formatted file size", async () => {
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    expect(screen.getByText("PNG")).toBeInTheDocument();

    loadImage(640, 480);
    expect(screen.getByText("640 × 480")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    });
  });

  it("formats byte and megabyte file sizes", async () => {
    getEntryInfo.mockResolvedValue({ size: 512 });
    const { unmount } = render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    await waitFor(() => expect(screen.getByText("512 B")).toBeInTheDocument());
    unmount();

    getEntryInfo.mockResolvedValue({ size: 3 * 1024 * 1024 });
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    await waitFor(() => expect(screen.getByText("3.0 MB")).toBeInTheDocument());
  });

  it("starts in fit mode and zooms in/out in custom steps", async () => {
    const user = userEvent.setup();
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    loadImage();
    expect(screen.getByText("Fit")).toBeInTheDocument();

    const [zoomOut, zoomIn] = screen.getAllByRole("button");
    await user.click(zoomIn);
    expect(screen.getByText("125%")).toBeInTheDocument();
    await user.click(zoomOut);
    await user.click(zoomOut);
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("clamps zoom at the minimum", async () => {
    const user = userEvent.setup();
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    const [zoomOut] = screen.getAllByRole("button");
    for (let i = 0; i < 6; i++) await user.click(zoomOut);
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("switches to 1:1 actual size and back to fit", async () => {
    const user = userEvent.setup();
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    const img = loadImage(300, 150);

    const [, , fitBtn, actualBtn] = screen.getAllByRole("button");
    await user.click(actualBtn);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(img.style.width).toBe("300px");
    expect(img.style.height).toBe("150px");

    await user.click(fitBtn);
    expect(screen.getByText("Fit")).toBeInTheDocument();
    expect(img.style.maxWidth).toBe("100%");
  });

  it("scales custom zoom from the natural size", async () => {
    const user = userEvent.setup();
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    const img = loadImage(200, 100);
    const [, zoomIn] = screen.getAllByRole("button");
    await user.click(zoomIn); // 1.25x
    expect(img.style.width).toBe("250px");
    expect(img.style.height).toBe("125px");
  });

  it("shows the error state when the image fails to load", async () => {
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    // 先等 getEntryInfo 状态落地，避免 act 警告
    await screen.findByText("2.0 KB");
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("Failed to load image")).toBeInTheDocument();
  });

  it("ignores getEntryInfo failures silently", async () => {
    getEntryInfo.mockRejectedValue(new Error("gone"));
    render(<ImagePreview filePath={FILE} projectPath="/proj" />);
    // 不崩溃且不显示文件大小
    await waitFor(() => expect(getEntryInfo).toHaveBeenCalled());
    expect(screen.getByText("PNG")).toBeInTheDocument();
  });
});
