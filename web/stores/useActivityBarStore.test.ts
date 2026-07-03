import { describe, it, expect, beforeEach } from "vitest";
import { useActivityBarStore } from "./useActivityBarStore";

function reset() {
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    appViewMode: "home",
    orchestrationOverlayOpen: false,
  });
}

describe("useActivityBarStore", () => {
  beforeEach(() => {
    reset();
  });

  describe("初始状态", () => {
    it("应有正确的默认值", () => {
      const s = useActivityBarStore.getState();
      expect(s.activeView).toBe("explorer");
      expect(s.sidebarVisible).toBe(true);
      expect(s.appViewMode).toBe("home");
      expect(s.orchestrationOverlayOpen).toBe(false);
    });
  });

  describe("toggleView", () => {
    it("传 orchestration 时应打开编排覆盖层并隐藏侧栏", () => {
      useActivityBarStore.getState().toggleView("orchestration");

      const s = useActivityBarStore.getState();
      expect(s.activeView).toBe("orchestration");
      expect(s.sidebarVisible).toBe(false);
      expect(s.orchestrationOverlayOpen).toBe(true);
    });

    it("再次传 orchestration 时应关闭覆盖层", () => {
      useActivityBarStore.setState({
        activeView: "orchestration",
        sidebarVisible: false,
        orchestrationOverlayOpen: true,
      });

      useActivityBarStore.getState().toggleView("orchestration");

      expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    });

    it("从 home 模式点击视图时应退回 panes 并切到该视图", () => {
      // 初始 appViewMode = home
      useActivityBarStore.getState().toggleView("sessions");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("panes");
      expect(s.activeView).toBe("sessions");
      expect(s.sidebarVisible).toBe(true);
      expect(s.orchestrationOverlayOpen).toBe(false);
    });

    it("在 panes 模式下点击当前视图应折叠侧栏", () => {
      useActivityBarStore.setState({
        appViewMode: "panes",
        activeView: "explorer",
        sidebarVisible: true,
      });

      useActivityBarStore.getState().toggleView("explorer");

      expect(useActivityBarStore.getState().sidebarVisible).toBe(false);
    });

    it("在 panes 模式下再次点击已折叠的当前视图应展开侧栏", () => {
      useActivityBarStore.setState({
        appViewMode: "panes",
        activeView: "explorer",
        sidebarVisible: false,
      });

      useActivityBarStore.getState().toggleView("explorer");

      expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
    });

    it("在 panes 模式下切换到新视图应展开侧栏", () => {
      useActivityBarStore.setState({
        appViewMode: "panes",
        activeView: "explorer",
        sidebarVisible: false,
      });

      useActivityBarStore.getState().toggleView("sessions");

      const s = useActivityBarStore.getState();
      expect(s.activeView).toBe("sessions");
      expect(s.sidebarVisible).toBe(true);
    });

    it("在 panes 模式下点击 files 应进入 files 模式", () => {
      useActivityBarStore.setState({
        appViewMode: "panes",
        activeView: "explorer",
        sidebarVisible: true,
      });

      useActivityBarStore.getState().toggleView("files");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("files");
      expect(s.activeView).toBe("files");
      expect(s.sidebarVisible).toBe(true);
    });

    it("在 files 模式下再次点击 files 应退回 panes", () => {
      useActivityBarStore.setState({
        appViewMode: "files",
        activeView: "files",
        sidebarVisible: true,
      });

      useActivityBarStore.getState().toggleView("files");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("panes");
      expect(s.activeView).toBe("explorer");
    });

    it("在 files 模式下切到其他视图应退回 panes 并切换视图", () => {
      useActivityBarStore.setState({
        appViewMode: "files",
        activeView: "files",
        sidebarVisible: true,
      });

      useActivityBarStore.getState().toggleView("sessions");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("panes");
      expect(s.activeView).toBe("sessions");
    });
  });

  describe("setSidebarVisible / toggleSidebar", () => {
    it("setSidebarVisible 应设置可见性", () => {
      useActivityBarStore.getState().setSidebarVisible(false);
      expect(useActivityBarStore.getState().sidebarVisible).toBe(false);
    });

    it("toggleSidebar 应翻转可见性", () => {
      useActivityBarStore.setState({ sidebarVisible: true });
      useActivityBarStore.getState().toggleSidebar();
      expect(useActivityBarStore.getState().sidebarVisible).toBe(false);
      useActivityBarStore.getState().toggleSidebar();
      expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
    });
  });

  describe("setAppViewMode", () => {
    it("设置普通模式应更新 appViewMode 并关闭覆盖层", () => {
      useActivityBarStore.setState({ orchestrationOverlayOpen: true });

      useActivityBarStore.getState().setAppViewMode("todo");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("todo");
      expect(s.orchestrationOverlayOpen).toBe(false);
    });

    it("设置 orchestration 时应打开覆盖层且保留原 appViewMode", () => {
      useActivityBarStore.setState({ appViewMode: "panes" });

      useActivityBarStore.getState().setAppViewMode("orchestration");

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("panes");
      expect(s.activeView).toBe("orchestration");
      expect(s.sidebarVisible).toBe(false);
      expect(s.orchestrationOverlayOpen).toBe(true);
    });

    it("从 orchestration 再设置 orchestration 时 appViewMode 应回到 panes", () => {
      useActivityBarStore.setState({ appViewMode: "orchestration" });

      useActivityBarStore.getState().setAppViewMode("orchestration");

      expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    });
  });

  describe("orchestration overlay 控制", () => {
    it("openOrchestrationOverlay 应打开覆盖层并隐藏侧栏", () => {
      useActivityBarStore.getState().openOrchestrationOverlay();

      const s = useActivityBarStore.getState();
      expect(s.activeView).toBe("orchestration");
      expect(s.sidebarVisible).toBe(false);
      expect(s.orchestrationOverlayOpen).toBe(true);
    });

    it("closeOrchestrationOverlay 应关闭覆盖层", () => {
      useActivityBarStore.setState({
        appViewMode: "orchestration",
        activeView: "orchestration",
        sidebarVisible: false,
        orchestrationOverlayOpen: true,
      });

      useActivityBarStore.getState().closeOrchestrationOverlay();

      const s = useActivityBarStore.getState();
      expect(s.orchestrationOverlayOpen).toBe(false);
      expect(s.appViewMode).toBe("panes");
    });

    it("toggleOrchestrationOverlay 应翻转覆盖层状态", () => {
      useActivityBarStore.setState({ orchestrationOverlayOpen: false });

      useActivityBarStore.getState().toggleOrchestrationOverlay();
      expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(true);

      useActivityBarStore.getState().toggleOrchestrationOverlay();
      expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    });
  });

  describe("模式切换 toggle*Mode", () => {
    it("toggleTodoMode 应在 todo 与 panes 间切换", () => {
      useActivityBarStore.setState({ appViewMode: "panes" });
      useActivityBarStore.getState().toggleTodoMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("todo");
      useActivityBarStore.getState().toggleTodoMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    });

    it("toggleSelfChatMode 应在 selfchat 与 panes 间切换", () => {
      useActivityBarStore.setState({ appViewMode: "panes" });
      useActivityBarStore.getState().toggleSelfChatMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("selfchat");
      useActivityBarStore.getState().toggleSelfChatMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    });

    it("toggleHomeMode 应在 home 与 panes 间切换", () => {
      useActivityBarStore.setState({ appViewMode: "home" });
      useActivityBarStore.getState().toggleHomeMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("panes");
      useActivityBarStore.getState().toggleHomeMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("home");
    });

    it("toggleProvidersMode 应在 providers 与 panes 间切换", () => {
      useActivityBarStore.setState({ appViewMode: "panes" });
      useActivityBarStore.getState().toggleProvidersMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("providers");
      useActivityBarStore.getState().toggleProvidersMode();
      expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    });

    it("toggleFilesMode 进入 files 模式应设置 activeView 为 files", () => {
      useActivityBarStore.setState({ appViewMode: "panes", activeView: "explorer" });

      useActivityBarStore.getState().toggleFilesMode();

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("files");
      expect(s.activeView).toBe("files");
      expect(s.sidebarVisible).toBe(true);
    });

    it("toggleFilesMode 从 files 模式退回应恢复 explorer", () => {
      useActivityBarStore.setState({ appViewMode: "files", activeView: "files" });

      useActivityBarStore.getState().toggleFilesMode();

      const s = useActivityBarStore.getState();
      expect(s.appViewMode).toBe("panes");
      expect(s.activeView).toBe("explorer");
    });

    it("模式切换应关闭编排覆盖层", () => {
      useActivityBarStore.setState({ appViewMode: "panes", orchestrationOverlayOpen: true });
      useActivityBarStore.getState().toggleTodoMode();
      expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    });
  });
});
